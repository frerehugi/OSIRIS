import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { verifyGrant, GrantError } from './grant';
import { buildCapabilities } from './capabilities';
import {
  compilePlan, compileSendPlan, compileDirectSend, encodePlanCode, ADDRESS_RE,
  type PlanDraft, type SellTriggerDraft, type SendPlanDraft, type DirectSendDraft,
} from './planCompiler';
import { getPlansForOwner } from './plans';
import { getBalancesForOwner } from './balances';
import { getSquidTokenPrices } from './squidPrices';
import { getAddressBook, type AddressBookKV } from './addressBook';
import { publicClient } from './client';

function errorMessage(err: unknown): string {
  return err instanceof GrantError ? err.message : 'Could not verify the access grant.';
}

// sendTokenEnum/anyTokenEnum aus capabilities.sendTokens abgeleitet statt
// separat hartkodiert — eine einzige Token-Symbol-Liste (siehe
// capabilities.ts, sendTokens-Kommentar zu "kein Squid-Routing nötig").
const SEND_TOKEN_SYMBOLS = ['USDC', 'USDT', 'cUSD', 'wBTC', 'wETH', 'CELO', 'XAUoT'] as const;

// env wird von worker.ts durchgereicht (Cloudflare-Workers-Ausführungsmodell:
// jeder fetch()-Aufruf bekommt sein eigenes env, siehe dortiger Kommentar) —
// nur für das Adressbuch-KV gebraucht, alle anderen Tools bleiben wie bisher
// zustandslos.
export interface ServerEnv {
  ADDRESS_BOOK: AddressBookKV;
}

export function buildServer(env: ServerEnv): McpServer {
  const server = new McpServer({ name: 'apis', version: '0.1.0' });

  // ── get_capabilities ──────────────────────────────────────────────────
  // Öffentlich, kein Grant nötig — beschreibt nur, was APIS/OSIRIS können.
  server.registerTool(
    'get_capabilities',
    {
      title: 'Get APIS capabilities',
      description:
        'Returns the tokens, plan constraints, fees, and price sources APIS/OSIRIS support. ' +
        'Call this first to know what kinds of plans can be proposed.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(buildCapabilities(), null, 2) }],
    }),
  );

  // ── get_token_prices ──────────────────────────────────────────────────
  // Öffentlich, kein Grant nötig — reine Marktdaten, nichts Wallet-Spezifisches.
  server.registerTool(
    'get_token_prices',
    {
      title: 'Get current Squid Router token prices',
      description:
        "Returns live USD prices for wBTC, wETH, CELO, and XAUoT (Gold) straight from Squid Router's own " +
        "/token-price API — the SAME price source OSIRIS/APIS actually uses to evaluate trigger plans " +
        "(see get_capabilities' priceSources). Always call this tool when asked about current, live, or " +
        "Squidrouter/Squid Router token prices — do not answer from general knowledge or an external source " +
        "like CoinGecko instead. Those can genuinely diverge from what OSIRIS/APIS itself checks, which would " +
        "give the user a misleading answer about whether/when their trigger plan is close to firing.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(await getSquidTokenPrices(), null, 2) }],
    }),
  );

  // ── get_balances ───────────────────────────────────────────────────────
  server.registerTool(
    'get_balances',
    {
      title: 'Get wallet balances',
      description:
        "Reads the grant owner's on-chain balances for all tokens APIS/OSIRIS support. " +
        "Requires a grant code with 'read' access, created in the APIS app.",
      inputSchema: { grantCode: z.string().describe('The code the user generated in APIS ("Create New Code for Agent").') },
    },
    async ({ grantCode }) => {
      let grant;
      try {
        grant = await verifyGrant(grantCode, 'read');
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }

      const result = await getBalancesForOwner(publicClient, grant.owner);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── get_plans ──────────────────────────────────────────────────────────
  server.registerTool(
    'get_plans',
    {
      title: 'Get the grant owner\'s plans',
      description:
        "Reads the grant owner's existing DCA and trigger (buy/sell) plans and their current status " +
        "(pending, active, cancelled, complete/executed, expired) directly from the OSIRIS contracts. " +
        "Does not include past purchase/execution history — only current plan status. " +
        "Requires a grant code with 'read' access, created in the APIS app.",
      inputSchema: { grantCode: z.string().describe('The code the user generated in APIS ("Create New Code for Agent").') },
    },
    async ({ grantCode }) => {
      let grant;
      try {
        grant = await verifyGrant(grantCode, 'read');
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }

      try {
        const result = await getPlansForOwner(publicClient, grant.owner);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: 'Could not read plans right now. Please try again.' }], isError: true };
      }
    },
  );

  // ── propose_plan ───────────────────────────────────────────────────────
  const targetTokenEnum = z.enum(['wBTC', 'wETH', 'CELO', 'XAUoT']);
  const anyTokenEnum = z.enum(['wBTC', 'wETH', 'CELO', 'XAUoT', 'USDC', 'USDT']);

  server.registerTool(
    'propose_plan',
    {
      title: 'Propose an OSIRIS plan',
      description:
        'Validates a DCA buy plan (and an optional conditional sell trigger) against the real OSIRIS contract ' +
        "constraints and compiles it into the exact parameters the APIS app needs. Does NOT execute anything — " +
        "the user still confirms and signs everything themselves in MiniPay. Requires a grant code with 'propose' access. " +
        'On success, the response includes a ready-to-use `planCode` field — give the user that exact string, ' +
        'verbatim and unmodified, as the "plan code" to paste into the APIS app\'s Confirm Plan screen. Do NOT ' +
        'construct, re-encode, or reconstruct this code yourself from the other fields — copy `planCode` exactly as given.',
      inputSchema: {
        grantCode:   z.string().describe('The code the user generated in APIS.'),
        inputToken:  z.enum(['USDC', 'USDT']),
        totalAmount: z.string().describe('Human-readable amount, e.g. "50.00".'),
        interval:    z.enum(['hourly', 'daily', 'weekly']),
        duration:    z.number().int().positive().describe('Number of tranches.'),
        targets:     z.array(z.object({ token: targetTokenEnum, bps: z.number().int().min(1).max(10_000) })),
        sellTrigger: z.object({
          sellToken:       targetTokenEnum.describe('The token to lock into the sell vault now.'),
          targetToken:     anyTokenEnum.describe('What to sell it for once the trigger fires.'),
          amount:          z.string().describe('Human-readable amount of sellToken to lock into the vault now, e.g. "0.05".'),
          triggerPriceUsd: z.number().positive().describe('Sell once the price is at or above this (take-profit).'),
          timeLimit:       z.enum(['1d', '1w', '1m', 'none']).default('none').describe('How long the plan stays open before it can no longer be executed. It can be cancelled any time regardless.'),
        }).optional().describe(
          'Optional attached sell-trigger plan, created as its own TriggerVault right after the buy plan — locks ' +
          "`amount` of sellToken into escrow immediately (only works for a token the user already holds), evaluated " +
          "off-chain by OSIRIS' shared keeper. Skipped automatically if the user does not currently hold enough sellToken.",
        ),
      },
    },
    async ({ grantCode, sellTrigger, ...draft }) => {
      let grant;
      try {
        grant = await verifyGrant(grantCode, 'propose');
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }

      const planDraft: PlanDraft = { owner: grant.owner, ...draft };
      const result = compilePlan(planDraft, sellTrigger as SellTriggerDraft | undefined);

      if (!result.valid) {
        return { content: [{ type: 'text', text: JSON.stringify({ valid: false, errors: result.errors }, null, 2) }], isError: true };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── propose_send_plan ─────────────────────────────────────────────────
  server.registerTool(
    'propose_send_plan',
    {
      title: 'Propose a scheduled, multi-recipient send plan',
      description:
        'Validates a scheduled payout (one or more recipients, each with their own total amount, paid out in ' +
        "equal installments over time) against the real OSIRIS SendVault contract constraints. Does NOT execute " +
        "anything — the user still confirms and signs everything themselves in MiniPay. Requires a grant code with " +
        "'propose' access. For a single, immediate, one-off transfer use propose_direct_send instead — this tool " +
        'is for anything scheduled or split across multiple recipients. On success, the response includes a ' +
        'ready-to-use `planCode` field — give the user that exact string, verbatim and unmodified, as the "plan ' +
        'code" to paste into the APIS app\'s Confirm Plan screen (it auto-detects this is a send plan). Do NOT ' +
        'construct, re-encode, or reconstruct this code yourself from the other fields — copy `planCode` exactly as given.',
      inputSchema: {
        grantCode: z.string().describe('The code the user generated in APIS.'),
        token:     z.enum(SEND_TOKEN_SYMBOLS).describe('The token to send — the user must already hold it.'),
        recipients: z.array(z.object({
          address:     z.string().describe('A raw 0x wallet address. NEVER a name — resolve names via get_address_book first, or ask the user for the address.'),
          totalAmount: z.string().describe('Human-readable amount this recipient receives IN TOTAL over the whole plan, e.g. "50.00".'),
        })).min(1).max(10),
        interval: z.enum(['hourly', 'daily', 'weekly']),
        duration: z.number().int().positive().describe('Number of payouts each recipient\'s total is split evenly across.'),
      },
    },
    async ({ grantCode, ...draft }) => {
      let grant;
      try {
        grant = await verifyGrant(grantCode, 'propose');
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }

      const planDraft: SendPlanDraft = { owner: grant.owner, ...draft };
      const result = compileSendPlan(planDraft);

      if (!result.valid) {
        return { content: [{ type: 'text', text: JSON.stringify({ valid: false, errors: result.errors }, null, 2) }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── propose_direct_send ───────────────────────────────────────────────
  server.registerTool(
    'propose_direct_send',
    {
      title: 'Propose a single, immediate transfer',
      description:
        'Validates a one-off, immediate transfer of a token the user already holds. No vault, no keeper, no fee — ' +
        'runs as a single plain wallet transfer the user signs directly in MiniPay, right after confirming. For ' +
        'anything scheduled or split across multiple recipients use propose_send_plan instead. Requires a grant ' +
        "code with 'propose' access. On success, the response includes a ready-to-use `planCode` field — give " +
        'the user that exact string, verbatim and unmodified, as the "plan code" to paste into the APIS app\'s ' +
        'Confirm Plan screen. Do NOT construct, re-encode, or reconstruct this code yourself from the other fields — ' +
        'copy `planCode` exactly as given.',
      inputSchema: {
        grantCode: z.string().describe('The code the user generated in APIS.'),
        token:     z.enum(SEND_TOKEN_SYMBOLS),
        to:        z.string().describe('A raw 0x wallet address. NEVER a name — resolve names via get_address_book first, or ask the user for the address.'),
        amount:    z.string().describe('Human-readable amount, e.g. "5.00".'),
      },
    },
    async ({ grantCode, ...draft }) => {
      try {
        await verifyGrant(grantCode, 'propose');
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }

      const result = compileDirectSend(draft as DirectSendDraft);
      if (!result.valid) {
        return { content: [{ type: 'text', text: JSON.stringify({ valid: false, errors: result.errors }, null, 2) }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── get_address_book ──────────────────────────────────────────────────
  server.registerTool(
    'get_address_book',
    {
      title: "Get the grant owner's saved contacts",
      description:
        "Reads the grant owner's saved address book (name -> wallet address) so you can reference people by name " +
        "in conversation and reuse an already-saved address instead of asking for it again. Requires a grant code " +
        "with 'read' access.",
      inputSchema: { grantCode: z.string().describe('The code the user generated in APIS ("Create New Code for Agent").') },
    },
    async ({ grantCode }) => {
      let grant;
      try {
        grant = await verifyGrant(grantCode, 'read');
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }

      const entries = await getAddressBook(env.ADDRESS_BOOK, grant.owner);
      return { content: [{ type: 'text', text: JSON.stringify({ owner: grant.owner, contacts: entries }, null, 2) }] };
    },
  );

  // ── propose_address_book_entry ────────────────────────────────────────
  //
  // Schreibt NIE selbst — validiert nur Form und gibt einen "contact code"
  // zurück, den der Nutzer in ConfirmContact.tsx einfügt. Erst dort, nachdem
  // der Nutzer die VOLLE Adresse gesehen hat und die Aktion in MiniPay
  // signiert, landet der Eintrag im Adressbuch (siehe contactSignature.ts).
  // Der Chat kann also vorschlagen, aber nie schreiben — gleiches Prinzip
  // wie Sterntalers addressBook.ts, nur auf ein server-seitiges KV übertragen.
  server.registerTool(
    'propose_address_book_entry',
    {
      title: 'Propose a new address book contact',
      description:
        'Validates a name/address pair and prepares it for the user to confirm. Does NOT save anything — the ' +
        'entry is only ever written after the user reviews the full address and confirms in the APIS app. ' +
        "Requires a grant code with 'propose' access. On success, the response includes a ready-to-use " +
        '`contactCode` field — give the user that exact string, verbatim and unmodified, as the "contact code" ' +
        'to paste into the APIS app\'s Address Book screen. Do NOT construct, re-encode, or reconstruct this code ' +
        'yourself from the other fields — copy `contactCode` exactly as given.',
      inputSchema: {
        grantCode: z.string().describe('The code the user generated in APIS.'),
        name:      z.string().min(1).max(60),
        address:   z.string().describe('A raw 0x wallet address. NEVER guess this or infer it from a name — only use an address the user gave you directly.'),
      },
    },
    async ({ grantCode, name, address }) => {
      try {
        await verifyGrant(grantCode, 'propose');
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }

      if (!ADDRESS_RE.test(address)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ valid: false, errors: [`'${address}' is not a valid wallet address (0x + 40 hex chars).`] }, null, 2) }],
          isError: true,
        };
      }

      const compiled = { valid: true as const, name, address };
      return { content: [{ type: 'text', text: JSON.stringify({ ...compiled, contactCode: encodePlanCode(compiled) }, null, 2) }] };
    },
  );

  return server;
}
