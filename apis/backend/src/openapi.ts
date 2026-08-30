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
const SEND_TOKEN_ENUM = ['USDC', 'USDT', 'cUSD', 'wBTC', 'wETH', 'CELO', 'XAUoT'];

export const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'APIS — OSIRIS Agent API',
    version: '0.1.0',
    description:
      'Read-only wallet/plan lookups and plan proposals for the OSIRIS DCA/trigger-vault contracts on Celo. ' +
      'Every endpoint except /capabilities requires a grantCode the user generates in the APIS app ' +
      '("Create New Code for Agent") — a self-verifying, time-limited EIP-712 signature, not an API key. ' +
      'This API never executes anything and never holds funds: propose_plan only returns unsigned transaction ' +
      'parameters, which the user must confirm and sign themselves in MiniPay.',
  },
  servers: [{ url: SERVER_URL }],
  paths: {
    '/capabilities': {
      get: {
        operationId: 'getCapabilities',
        summary: 'Get APIS/OSIRIS capabilities',
        description: 'Returns the tokens, plan constraints, fees, and price sources OSIRIS supports. Call this first, no grant needed.',
        responses: { '200': { description: 'Capabilities object.' } },
      },
    },
    '/balances': {
      post: {
        operationId: 'getBalances',
        summary: "Get the grant owner's wallet balances",
        description: "Reads the grant owner's on-chain balances for all tokens APIS/OSIRIS support. Requires a grant code with 'read' access.",
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['grantCode'],
                properties: {
                  grantCode: { type: 'string', description: 'The code the user generated in APIS ("Create New Code for Agent").' },
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
                  grantCode: { type: 'string', description: 'The code the user generated in APIS ("Create New Code for Agent").' },
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
          'constraints and compiles it into the exact parameters the APIS app needs. Does NOT execute anything — ' +
          "the user still confirms and signs everything themselves in MiniPay. Requires a grant code with 'propose' access. " +
          'On success, the response includes a ready-to-use `planCode` field — give the user that exact string, ' +
          'verbatim and unmodified, as the "plan code" to paste into the APIS app\'s Confirm Plan screen. Do NOT ' +
          'construct, re-encode, or reconstruct this code yourself from the other fields — copy `planCode` exactly as given.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['grantCode', 'inputToken', 'totalAmount', 'interval', 'duration', 'targets'],
                properties: {
                  grantCode:   { type: 'string', description: 'The code the user generated in APIS.' },
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
          '200': { description: 'Compiled plan parameters, a human-readable summary, and a ready-to-use `planCode` field — relay `planCode` verbatim to the user, do not construct it yourself.' },
          '400': { description: 'Invalid grant code, or the plan draft failed validation (see `errors`).' },
        },
      },
    },
    '/propose-send': {
      post: {
        operationId: 'proposeSendPlan',
        summary: 'Propose a scheduled, multi-recipient send plan',
        description:
          'Validates a scheduled payout (one or more recipients, each with their own total amount, paid out in ' +
          "equal installments over time) against the real OSIRIS SendVault contract constraints. Does NOT execute " +
          "anything — the user still confirms and signs everything themselves in MiniPay. Requires a grant code " +
          "with 'propose' access. For a single immediate transfer use /direct-send instead. On success, the " +
          'response includes a ready-to-use `planCode` field — give the user that exact string, verbatim and ' +
          'unmodified, as the "plan code" to paste into the APIS app\'s Confirm Plan screen. Do NOT construct, ' +
          're-encode, or reconstruct this code yourself from the other fields — copy `planCode` exactly as given.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['grantCode', 'token', 'recipients', 'interval', 'duration'],
                properties: {
                  grantCode: { type: 'string', description: 'The code the user generated in APIS.' },
                  token:     { type: 'string', enum: SEND_TOKEN_ENUM, description: 'The token to send — the user must already hold it.' },
                  recipients: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['address', 'totalAmount'],
                      properties: {
                        address:     { type: 'string', description: 'A raw 0x wallet address. NEVER a name.' },
                        totalAmount: { type: 'string', description: 'Human-readable amount this recipient receives IN TOTAL over the whole plan, e.g. "50.00".' },
                      },
                    },
                  },
                  interval: { type: 'string', enum: ['hourly', 'daily', 'weekly'] },
                  duration: { type: 'integer', minimum: 1, description: "Number of payouts each recipient's total is split evenly across." },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Compiled send plan parameters, a human-readable summary, and a ready-to-use `planCode` field — relay `planCode` verbatim to the user, do not construct it yourself.' },
          '400': { description: 'Invalid grant code, or the plan draft failed validation (see `errors`).' },
        },
      },
    },
    '/direct-send': {
      post: {
        operationId: 'proposeDirectSend',
        summary: 'Propose a single, immediate transfer',
        description:
          'Validates a one-off, immediate transfer of a token the user already holds — no vault, no keeper, no fee. ' +
          "Requires a grant code with 'propose' access. On success, the response includes a ready-to-use " +
          '`planCode` field — give the user that exact string, verbatim and unmodified, as the "plan code" to ' +
          'paste into the APIS app\'s Confirm Plan screen. Do NOT construct, re-encode, or reconstruct this code ' +
          'yourself from the other fields — copy `planCode` exactly as given.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['grantCode', 'token', 'to', 'amount'],
                properties: {
                  grantCode: { type: 'string', description: 'The code the user generated in APIS.' },
                  token:     { type: 'string', enum: SEND_TOKEN_ENUM },
                  to:        { type: 'string', description: 'A raw 0x wallet address. NEVER a name.' },
                  amount:    { type: 'string', description: 'Human-readable amount, e.g. "5.00".' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Compiled transfer parameters, a human-readable summary, and a ready-to-use `planCode` field — relay `planCode` verbatim to the user, do not construct it yourself.' },
          '400': { description: 'Invalid grant code, or the draft failed validation (see `errors`).' },
        },
      },
    },
    '/address-book': {
      post: {
        operationId: 'getAddressBook',
        summary: "Get the grant owner's saved contacts",
        description: "Reads the grant owner's saved address book (name -> wallet address). Requires a grant code with 'read' access.",
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['grantCode'],
                properties: { grantCode: { type: 'string', description: 'The code the user generated in APIS.' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'The saved contacts.' },
          '400': { description: 'Invalid or expired grant code.' },
        },
      },
    },
    '/address-book/propose': {
      post: {
        operationId: 'proposeAddressBookEntry',
        summary: 'Propose a new address book contact',
        description:
          'Validates a name/address pair and prepares it for the user to confirm. Does NOT save anything — the ' +
          "entry is only written after the user confirms in the APIS app. Requires a grant code with 'propose' " +
          'access. On success, the response includes a ready-to-use `contactCode` field — give the user that ' +
          'exact string, verbatim and unmodified, as the "contact code" to paste into the APIS app\'s Address ' +
          'Book screen. Do NOT construct, re-encode, or reconstruct this code yourself from the other fields — ' +
          'copy `contactCode` exactly as given.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['grantCode', 'name', 'address'],
                properties: {
                  grantCode: { type: 'string', description: 'The code the user generated in APIS.' },
                  name:      { type: 'string' },
                  address:   { type: 'string', description: 'A raw 0x wallet address. Never guess this or infer it from a name.' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Validated name/address plus a ready-to-use `contactCode` field — relay `contactCode` verbatim to the user, do not construct it yourself.' },
          '400': { description: 'Invalid grant code, or the address is malformed.' },
        },
      },
    },
  },
} as const;
