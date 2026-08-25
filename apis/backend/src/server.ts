import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { verifyGrant, GrantError } from './grant';
import { buildCapabilities } from './capabilities';
import { compilePlan, type PlanDraft, type SellTriggerDraft } from './planCompiler';
import { getPlansForOwner } from './plans';
import { getBalancesForOwner } from './balances';
import { publicClient } from './client';

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
        "constraints and compiles it into the exact parameters the Apis app needs. Does NOT execute anything — " +
        "the user still confirms and signs everything themselves in MiniPay. Requires a grant code with 'propose' access. " +
        'On success, base64url-encode the JSON result (as a single line, no extra fields) and give that string to the ' +
        'user as a "plan code" to paste into the Apis app\'s Confirm Plan screen.',
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

  return server;
}
