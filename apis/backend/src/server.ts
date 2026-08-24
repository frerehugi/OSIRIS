import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createPublicClient, http, fallback, formatUnits } from 'viem';
import { celo } from 'viem/chains';
import { verifyGrant, GrantError } from './grant';
import { buildCapabilities } from './capabilities';
import { compilePlan, type PlanDraft, type SellTriggerDraft } from './planCompiler';
import { ERC20_ABI } from '../../../src/dcaVaultAbi';
import { INPUT_TOKENS, TARGET_TOKENS } from '../../../src/config';

// Gleiche RPC-Fallback-Strategie wie OSIRIS' und Apis' Keeper — bewusst
// wiederverwendetes Muster, kein neuer Anbieter.
const RPC_URLS = ['https://forno.celo.org', 'https://rpc.ankr.com/celo'];
const publicClient = createPublicClient({ chain: celo, transport: fallback(RPC_URLS.map((url) => http(url))) });

const BALANCE_TOKENS = [
  INPUT_TOKENS.USDC,
  INPUT_TOKENS.USDT,
  TARGET_TOKENS.CELO,
  TARGET_TOKENS.XAUoT,
  TARGET_TOKENS.wBTC,
  TARGET_TOKENS.wETH,
] as const;

function errorMessage(err: unknown): string {
  return err instanceof GrantError ? err.message : 'Could not verify the access grant.';
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'apis', version: '0.1.0' });

  // ── get_capabilities ──────────────────────────────────────────────────
  // Öffentlich, kein Grant nötig — beschreibt nur, was Apis/OSIRIS können.
  server.registerTool(
    'get_capabilities',
    {
      title: 'Get Apis capabilities',
      description:
        'Returns the tokens, plan constraints, fees, and price sources Apis/OSIRIS support. ' +
        'Call this first to know what kinds of plans can be proposed.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(buildCapabilities(), null, 2) }],
    }),
  );

  // ── get_balances ───────────────────────────────────────────────────────
  server.registerTool(
    'get_balances',
    {
      title: 'Get wallet balances',
      description:
        "Reads the grant owner's on-chain balances for all tokens Apis/OSIRIS support. " +
        "Requires a grant code with 'read' access, created in the Apis app.",
      inputSchema: { grantCode: z.string().describe('The code the user generated in Apis ("Create New Code for Agent").') },
    },
    async ({ grantCode }) => {
      let grant;
      try {
        grant = await verifyGrant(grantCode, 'read');
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }

      const results = await Promise.all(
        BALANCE_TOKENS.map(async (token) => {
          try {
            const raw = await publicClient.readContract({
              address: token.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [grant.owner],
            }) as bigint;
            return { symbol: token.symbol, balance: formatUnits(raw, token.decimals) };
          } catch {
            return { symbol: token.symbol, balance: null, error: 'Could not read this balance right now.' };
          }
        }),
      );

      return { content: [{ type: 'text', text: JSON.stringify({ owner: grant.owner, balances: results }, null, 2) }] };
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
        "constraints and compiles it into the exact parameters the Apis app needs. Does NOT execute anything — " +
        "the user still confirms and signs everything themselves in MiniPay. Requires a grant code with 'propose' access.",
      inputSchema: {
        grantCode:   z.string().describe('The code the user generated in Apis.'),
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
          'off-chain by the Apis keeper. Skipped automatically if the user does not currently hold enough sellToken.',
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

  return server;
}
