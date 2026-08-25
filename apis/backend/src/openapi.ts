// OpenAPI-Schema für die REST-Schicht (rest.ts) — dieselben vier
// Fähigkeiten wie die MCP-Tools in server.ts (get_capabilities/get_balances/
// get_plans/propose_plan), hier als HTTP+JSON-Endpunkte für Plattformen ohne
// MCP-Unterstützung (ChatGPT Custom-GPT-Actions, Gemini Gems/Extensions,
// Grok Function-Calling). Statisches Objekt, unter GET /openapi.json
// ausgeliefert — genau die URL, die man in ChatGPTs Action-Import-Dialog
// einträgt.

const SERVER_URL = 'https://apis-backend.frerehugi.workers.dev';

const TARGET_TOKEN_ENUM = ['wBTC', 'wETH', 'CELO', 'XAUoT'];
const ANY_TOKEN_ENUM = ['wBTC', 'wETH', 'CELO', 'XAUoT', 'USDC', 'USDT'];

export const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'Apis — OSIRIS Agent API',
    version: '0.1.0',
    description:
      'Read-only wallet/plan lookups and plan proposals for the OSIRIS DCA/trigger-vault contracts on Celo. ' +
      'Every endpoint except /capabilities requires a grantCode the user generates in the Apis app ' +
      '("Create New Code for Agent") — a self-verifying, time-limited EIP-712 signature, not an API key. ' +
      'This API never executes anything and never holds funds: propose_plan only returns unsigned transaction ' +
      'parameters, which the user must confirm and sign themselves in MiniPay.',
  },
  servers: [{ url: SERVER_URL }],
  paths: {
    '/capabilities': {
      get: {
        operationId: 'getCapabilities',
        summary: 'Get Apis/OSIRIS capabilities',
        description: 'Returns the tokens, plan constraints, fees, and price sources OSIRIS supports. Call this first, no grant needed.',
        responses: { '200': { description: 'Capabilities object.' } },
      },
    },
    '/balances': {
      post: {
        operationId: 'getBalances',
        summary: "Get the grant owner's wallet balances",
        description: "Reads the grant owner's on-chain balances for all tokens Apis/OSIRIS support. Requires a grant code with 'read' access.",
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['grantCode'],
                properties: {
                  grantCode: { type: 'string', description: 'The code the user generated in Apis ("Create New Code for Agent").' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Balances by token symbol.' },
          '400': { description: 'Invalid or expired grant code.' },
        },
      },
    },
    '/plans': {
      post: {
        operationId: 'getPlans',
        summary: "Get the grant owner's existing plans",
        description:
          "Reads the grant owner's existing DCA and trigger (buy/sell) plans and their current status " +
          "(pending, active, cancelled, complete/executed, expired) directly from the OSIRIS contracts. " +
          "Does not include past purchase/execution history. Requires a grant code with 'read' access.",
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['grantCode'],
                properties: {
                  grantCode: { type: 'string', description: 'The code the user generated in Apis ("Create New Code for Agent").' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'DCA and trigger plans with their current status.' },
          '400': { description: 'Invalid or expired grant code.' },
        },
      },
    },
    '/propose': {
      post: {
        operationId: 'proposePlan',
        summary: 'Propose an OSIRIS DCA buy plan, optionally with an attached sell trigger',
        description:
          'Validates a DCA buy plan (and an optional conditional sell trigger) against the real OSIRIS contract ' +
          'constraints and compiles it into the exact parameters the Apis app needs. Does NOT execute anything — ' +
          "the user still confirms and signs everything themselves in MiniPay. Requires a grant code with 'propose' access. " +
          'On success, base64url-encode the JSON result (as a single line, no extra fields) and give that string to the ' +
          'user as a "plan code" to paste into the Apis app\'s Confirm Plan screen.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['grantCode', 'inputToken', 'totalAmount', 'interval', 'duration', 'targets'],
                properties: {
                  grantCode:   { type: 'string', description: 'The code the user generated in Apis.' },
                  inputToken:  { type: 'string', enum: ['USDC', 'USDT'] },
                  totalAmount: { type: 'string', description: 'Human-readable amount, e.g. "50.00".' },
                  interval:    { type: 'string', enum: ['hourly', 'daily', 'weekly'] },
                  duration:    { type: 'integer', minimum: 1, description: 'Number of tranches.' },
                  targets: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['token', 'bps'],
                      properties: {
                        token: { type: 'string', enum: TARGET_TOKEN_ENUM },
                        bps:   { type: 'integer', minimum: 1, maximum: 10_000, description: 'Allocation in basis points; all targets must sum to 10000.' },
                      },
                    },
                  },
                  sellTrigger: {
                    type: 'object',
                    description:
                      'Optional attached sell-trigger plan, created as its own TriggerVault right after the buy plan — locks ' +
                      "`amount` of sellToken into escrow immediately (only works for a token the user already holds), evaluated " +
                      "off-chain by OSIRIS' shared keeper. Skipped automatically if the user does not currently hold enough sellToken.",
                    required: ['sellToken', 'targetToken', 'amount', 'triggerPriceUsd'],
                    properties: {
                      sellToken:       { type: 'string', enum: TARGET_TOKEN_ENUM, description: 'The token to lock into the sell vault now.' },
                      targetToken:     { type: 'string', enum: ANY_TOKEN_ENUM, description: 'What to sell it for once the trigger fires.' },
                      amount:          { type: 'string', description: 'Human-readable amount of sellToken to lock into the vault now, e.g. "0.05".' },
                      triggerPriceUsd: { type: 'number', exclusiveMinimum: 0, description: 'Sell once the price is at or above this (take-profit).' },
                      timeLimit: {
                        type: 'string', enum: ['1d', '1w', '1m', 'none'], default: 'none',
                        description: 'How long the plan stays open before it can no longer be executed. It can be cancelled any time regardless.',
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Compiled plan parameters and a human-readable summary.' },
          '400': { description: 'Invalid grant code, or the plan draft failed validation (see `errors`).' },
        },
      },
    },
  },
} as const;
