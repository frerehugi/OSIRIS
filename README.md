# OSIRIS

**OSnabrück Investment and Risk Management System**

A non-custodial DeFi protocol on Celo, accessible via MiniPay. Every plan gets its **own dedicated vault clone** — created on demand through a factory contract — across three independent vault types: a recurring DCA (Dollar-Cost Averaging) plan that invests a stablecoin into a self-chosen basket of wBTC, wETH, CELO and XAUoT (Tether Gold) on a schedule, a one-shot price-triggered buy/sell, and a scheduled multi-recipient send. Swap routing goes exclusively through [Squid Router](https://www.squidrouter.com/), which sources liquidity across all DEXs on Celo instead of relying on a single fixed pool. [`apis/`](apis/) is a companion MCP/REST agent layer (`apis/backend`) plus a MiniPay Mini App (`apis/app`) that let an AI assistant propose plans on the same vaults for the user to confirm and sign themselves.

🔴 **Live on Celo Mainnet** — [frerehugi.github.io/OSIRIS](https://frerehugi.github.io/OSIRIS) · [Open the app](https://frerehugi.github.io/OSIRIS/app/)

---

## Architecture

```
osiris/
├── contracts/
│   ├── DcaVault.sol             # DCA vault logic — clone implementation (EIP-1167)
│   ├── DcaVaultFactory.sol      # Creates one DCA vault clone per user
│   ├── TriggerVault.sol         # Price-trigger vault — one-shot buy/sell (EIP-1167 clone, one per plan)
│   ├── TriggerVaultFactory.sol  # Creates one TriggerVault clone per plan
│   ├── SendVault.sol            # Multi-recipient payout vault — no swap, own factory
│   └── SendVaultFactory.sol     # Creates one SendVault clone per plan
├── script/
│   ├── DeployFactory.s.sol             # Deploys DCA implementation + factory (Mainnet)
│   ├── DeployTriggerVaultFactory.s.sol # Deploys TriggerVault implementation + factory (Mainnet)
│   ├── DeploySendVaultFactory.s.sol    # Deploys SendVault implementation + factory (Mainnet)
│   └── DeployMocks.s.sol               # Mock wBTC/XAUoT ERC-20s (Sepolia only)
├── test/
│   ├── DcaVault.t.sol          # DCA vault unit tests
│   ├── DcaVaultFactory.t.sol   # DCA factory unit tests
│   ├── TriggerVault.t.sol      # Trigger vault unit tests
│   ├── SendVault.t.sol         # Send vault unit tests
│   ├── SendVaultFactory.t.sol  # Send factory unit tests
│   └── mocks/                  # MockERC20, MockSquidRouter, MockFeeOnTransferERC20
├── keeper/
│   └── squidKeeper.ts         # Automated executor (Node.js) — DCA tranches, trigger plans, send plans, same wallet
├── .github/workflows/
│   └── keeper.yml             # Manual/backup keeper run — production automation is a Cloudflare Worker
│                               # cron (keeper/worker.ts, every 5 minutes, see Automation section below)
├── apis/
│   ├── backend/                # MCP + REST agent layer (Cloudflare Worker) — lets an AI assistant
│   │                            # propose DCA/trigger/send plans and address-book entries for the user
│   │                            # to confirm; never holds funds or signs anything itself
│   └── app/                    # MiniPay Mini App companion — confirms AI-proposed plans, manages
│                               # access grants and the address book
├── src/
│   ├── App.tsx                 # React frontend — connect, "Your Plans" (DCA + trigger), DCA wizard, trigger wizard
│   ├── App.css                 # Dark/gold theme
│   ├── config.ts                # Chain IDs, contract + token addresses
│   ├── dcaVaultAbi.ts           # DcaVault + DcaVaultFactory ABIs
│   ├── triggerVaultAbi.ts       # TriggerVault + TriggerVaultFactory ABIs
│   ├── minipayWallet.ts         # MiniPay / viem wallet integration (DCA + trigger plans)
│   ├── types.ts                 # Shared TypeScript interfaces
│   └── demo/                    # Standalone design mockups (not wired to the chain)
├── index.html                   # Landing page (gh-pages branch)
└── public/banner.jpg             # OSIRIS banner image
```

The `gh-pages` branch hosts the static site: `index.html` (landing page) at the root and the compiled frontend (`npm run build` output) under `app/`.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Wallet | MiniPay (Celo), viem v2 |
| Smart Contracts | Solidity 0.8.20, OpenZeppelin (Clones, SafeERC20, ReentrancyGuard) |
| Vault Pattern | EIP-1167 Minimal Proxy Clones — one cheap clone per user via a factory |
| Routing | Squid Router v2 (exclusive — no direct Uniswap integration) |
| Keeper | Node.js/TypeScript core (`keeper/squidKeeper.ts`), shared by a Cloudflare Worker cron (production) and a CLI/GitHub Actions entry point (manual/backup) |
| Automation | Cloudflare Worker cron, every 5 minutes (`keeper/wrangler.toml`) — primary; `.github/workflows/keeper.yml` is manual/backup only |
| Testing | Foundry (`forge test`) — 177 tests across five suites |
| Network | Celo Mainnet (Squid does not support Celo Sepolia) |

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

`src/config.ts` already contains the live Mainnet addresses (Factory, Vault implementation, Squid Router, token list). If you deploy your own instance, update:

```ts
export const FACTORY_ADDRESS              = "0x..."; // from DeployFactory.s.sol
export const VAULT_IMPLEMENTATION_ADDRESS = "0x...";
export const SQUID_INTEGRATOR_ID          = "..."; // request at https://app.squidrouter.com/
```

### 3. Run frontend (dev)

```bash
npm run dev
# → http://localhost:5173
```

### 4. Type check / build

```bash
npm run typecheck
npm run build   # outputs to dist/
```

---

## Smart Contracts

### How it works

1. `DcaVaultFactory.createVault()` clones `DcaVault` (EIP-1167) and calls `initialize(owner, squidRouter)` in the same transaction — no constructor, no front-running window.
2. The user approves the new vault address for the input token, then calls `setupPlan(...)` on it directly.
3. A keeper calls `executeStep(routers[], minAmountsOut[], squidCallData[])` once per tranche. The vault only checks that each router is owner-approved (`approvedRouters`) and that the owner's balance of the target token increased by at least `minAmountsOut[i]` — it never inspects *what* the calldata does, which decouples the vault from any specific DEX.

### Deploy (Celo Mainnet)

```bash
forge script script/DeployFactory.s.sol \
  --rpc-url celo_mainnet \
  --broadcast \
  --verify \
  -vvvv
```

Deploys the `DcaVault` implementation and `DcaVaultFactory` (constructor args: implementation address, Squid Router address), then verifies both on Celoscan.

### Live Deployment (Celo Mainnet, chain ID `42220`)

| Contract | Address |
|---|---|
| DcaVaultFactory (current) | [`0xba148255d757912442A97f87c50DD2F65FBab7E0`](https://celoscan.io/address/0xba148255d757912442a97f87c50dd2f65fbab7e0#code) |
| DcaVaultFactory (previous, still serving pre-existing plans) | [`0x28f5E38C41F2cDB6D436972df5F3F42bD40Ed411`](https://celoscan.io/address/0x28f5e38c41f2cdb6d436972df5f3f42bd40ed411#code) |
| DcaVault (implementation) | [`0xeB05629ABB85f6aa23044e6a85708477E43b87fd`](https://celoscan.io/address/0xeb05629abb85f6aa23044e6a85708477e43b87fd#code) |
| TriggerVaultFactory | [`0xeD39de472baEE17e6Ce05a0A4A0515eb4DF98a97`](https://celoscan.io/address/0xed39de472baee17e6ce05a0a4a0515eb4df98a97#code) |
| TriggerVault (implementation) | [`0x10FC1B7BF6d2c8e429f40C7536c35303D1CdF3D9`](https://celoscan.io/address/0x10fc1b7bf6d2c8e429f40c7536c35303d1cdf3d9#code) |
| SendVaultFactory | [`0x1d7a157Bb1823482039B4B3037fb1737B1F2750A`](https://celoscan.io/address/0x1d7a157bb1823482039b4b3037fb1737b1f2750a#code) |
| SendVault (implementation) | [`0x09B4bCA1f8C2103b6469F77C0035dA82100DaCCB`](https://celoscan.io/address/0x09b4bca1f8c2103b6469f77c0035da82100daccb#code) |
| Squid Router | `0xce16F69375520ab01377ce7B88f5BA8C48F8D666` |

### Trigger Plans

Alongside the recurring DCA vault, OSIRIS 1.1 adds a second, independent vault type for one-shot, price-triggered buys and sells: `TriggerVaultFactory.createVault()` clones `TriggerVault` (same EIP-1167 pattern as DCA) for exactly one plan — buy a target token once its price drops to a chosen level, or sell a holding once it rises to one. `triggerAbove`/`triggerPrice` are stored on-chain but checked off-chain by the keeper (no price oracle); `expiresAt` (optional) and `cancel()` (always available, any time) are enforced on-chain. Deploy with:

```bash
forge script script/DeployTriggerVaultFactory.s.sol \
  --rpc-url celo_mainnet \
  --broadcast \
  --verify \
  -vvvv
```

Deployed and verified on Celo Mainnet (see the table above).

### Send Plans

A third, independent vault type for scheduled, multi-recipient payouts — no swap, no router, no `minAmountOut`: the sender already holds the token, `SendVaultFactory.createVault()` clones `SendVault` for a `RecipientPlan[]` (wallet + total amount per recipient), split evenly across the plan's payouts on the same duration/interval schedule as a DCA plan. Deploy with:

```bash
forge script script/DeploySendVaultFactory.s.sol \
  --rpc-url celo_mainnet \
  --broadcast \
  --verify \
  -vvvv
```

Deployed and verified on Celo Mainnet (see the table above).

### Testing

```bash
forge test -vvv
```

177 tests across five suites (`DcaVault.t.sol`, `DcaVaultFactory.t.sol`, `TriggerVault.t.sol` — the latter covers both `TriggerVault` and `TriggerVaultFactory` — `SendVault.t.sol`, `SendVaultFactory.t.sol`), covering setup validation, execution, slippage/router/failure guards, cancellation, expiry, fee-on-transfer handling, and factory clone creation.

---

## Keeper Service

The keeper reads `DcaVaultFactory.getAllVaults()` (supports multiple factory addresses, comma-separated, so already-funded plans on a previous factory keep executing after a migration) plus any legacy vault deployed before the factory existed, batches `canExecute()` reads (groups of 10, to be gentle on the RPC provider), and for every vault that's due: fetches a real, executable route per target token from Squid (`quoteOnly: false`), simulates `executeStep(...)`, then broadcasts it.

The same cycle also handles trigger plans and send plans, using the same wallet — no separate process or secrets. Trigger plans: reads all `TriggerVaultFactory` vaults, filters by `canExecute()` (on-chain: initialized/not cancelled/not executed/not expired), fetches the watched token's price from Squid's `/token-price`, and executes any vault whose stored `triggerAbove`/`triggerPrice` condition is met — the contract itself has no price oracle, this check is entirely off-chain (see Known Limitations). Send plans: reads all `SendVaultFactory` vaults, filters by `canExecute()`, and calls `executeStep()` on any due plan — no swap, no price involved.

```bash
# keeper/.env (never commit!)
KEEPER_PRIVATE_KEY=0x...
SQUID_INTEGRATOR_ID=...       # from https://app.squidrouter.com/
FACTORY_ADDRESSES=0xba148255d757912442A97f87c50DD2F65FBab7E0,0x28f5E38C41F2cDB6D436972df5F3F42bD40Ed411

npm run keeper
```

`TRIGGER_VAULT_FACTORY_ADDRESS`/`SEND_VAULT_FACTORY_ADDRESS` aren't environment variables — the keeper imports them straight from `src/config.ts`, same single source of truth as the frontend.

### Automation

**Production**: a Cloudflare Worker cron (`keeper/worker.ts`, schedule in `keeper/wrangler.toml`) runs the same keeper core every 5 minutes (`*/5 * * * *`).

`.github/workflows/keeper.yml` is a manual/backup path only (`workflow_dispatch`, no schedule — the cron trigger was deliberately disabled after GitHub Actions' schedule drifted 2.6–11.8h against its configured hourly run) — useful for a one-off run or debugging, not the primary automation. Requires `KEEPER_PRIVATE_KEY`, `SQUID_INTEGRATOR_ID`, and `FACTORY_ADDRESS` as repository secrets under **Settings → Secrets and variables → Actions**. Do not re-enable the schedule without first disabling the Cloudflare Worker cron — running both means two keepers racing on the same wallet.

---

## Token Addresses (Celo Mainnet)

| Token | Address | Role |
|---|---|---|
| USDC | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | Input |
| USDT | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | Input |
| cUSD | `0x765DE816845861e75A25fCA122bb6898B8B1282a` | Input — ⚠️ not currently routable via Squid |
| wBTC | `0x8aC2901Dd8A1F17a1A4768A6bA4C3751e3995B2D` | Target |
| wETH | `0xD221812de1BD094f35587EE8E174B07B6167D9Af` | Target |
| CELO | `0x471EcE3750Da237f93B8E339c536989b8978a438` | Target |
| XAUoT | `0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff` | Target — "XAUt0" (Tether Gold) on Squid |

Since routing moved to Squid (which aggregates across DEXs rather than using one fixed pool), `poolFee`/`tickSpacing` are no longer part of `TokenInfo` — Squid picks the route.

---

## Known Limitations

- **Squid rate limits**: a freshly issued integrator ID can have a very low rate limit (~0.27 req/s observed). The keeper spaces requests ~4s apart per target token with retry-with-backoff on `429`.
- **cUSD**: the on-chain contract still exists at its historical address, but was rebranded to "Mento Dollar" (USDm) and is not listed by Squid for Celo Mainnet routing.
- **Celo Sepolia**: Squid does not support it at all — there is no functional testnet path for the Squid-routing parts of this project. `DeployMocks.s.sol` remains for historical/local testing of the vault logic in isolation.

---

## License

MIT — University of Osnabrück
