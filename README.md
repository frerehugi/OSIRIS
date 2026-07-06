# OSIRIS

**OSnabrück Investment and Risk Management System**

A non-custodial DCA (Dollar-Cost Averaging) vault on Celo, accessible via MiniPay. Every user gets their **own dedicated vault** — created on demand through a factory contract — that automatically invests a stablecoin into a self-chosen basket of wBTC, wETH, CELO and XAUoT (Tether Gold) on a daily or weekly schedule. Routing goes exclusively through [Squid Router](https://www.squidrouter.com/), which sources liquidity across all DEXs on Celo instead of relying on a single fixed pool.

🔴 **Live on Celo Mainnet** — [frerehugi.github.io/OSIRIS](https://frerehugi.github.io/OSIRIS) · [Open the app](https://frerehugi.github.io/OSIRIS/app/)

---

## Architecture

```
osiris/
├── contracts/
│   ├── DcaVault.sol           # Vault logic — clone implementation (EIP-1167)
│   └── DcaVaultFactory.sol    # Creates one vault clone per user
├── script/
│   ├── DeployFactory.s.sol    # Deploys implementation + factory (Mainnet)
│   └── DeployMocks.s.sol      # Mock wBTC/XAUoT ERC-20s (Sepolia only)
├── test/
│   ├── DcaVault.t.sol         # Vault unit tests
│   ├── DcaVaultFactory.t.sol  # Factory unit tests
│   └── mocks/                 # MockERC20, MockSquidRouter
├── keeper/
│   └── squidKeeper.ts         # Automated multi-vault executor (Node.js)
├── .github/workflows/
│   └── keeper.yml             # Runs the keeper every hour via GitHub Actions
├── src/
│   ├── App.tsx                 # React frontend — connect, vault list, 6-step wizard
│   ├── App.css                 # Dark/gold theme
│   ├── config.ts                # Chain IDs, contract + token addresses
│   ├── dcaVaultAbi.ts           # DcaVault + DcaVaultFactory ABIs
│   ├── minipayWallet.ts         # MiniPay / viem wallet integration
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
| Keeper | Node.js, tsx, viem, axios |
| Automation | GitHub Actions (hourly cron + manual `workflow_dispatch`) |
| Testing | Foundry (`forge test`) |
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
| DcaVaultFactory | [`0x31bF80a905EA80e0F8A9d6C20b44B0daa2A3f9f5`](https://celoscan.io/address/0x31bf80a905ea80e0f8a9d6c20b44b0daa2a3f9f5#code) |
| DcaVault (implementation) | [`0x9d148530b0EE408EAA801D74D7eA968955F24d13`](https://celoscan.io/address/0x9d148530b0ee408eaa801d74d7ea968955f24d13#code) |
| Squid Router | `0xce16F69375520ab01377ce7B88f5BA8C48F8D666` |

### Testing

```bash
forge test -vvv
```

41 tests across two suites (`DcaVault.t.sol`, `DcaVaultFactory.t.sol`), covering setup validation, execution, slippage/router/failure guards, cancellation, and factory clone creation.

---

## Keeper Service

The keeper reads `DcaVaultFactory.getAllVaults()` plus any legacy vault deployed before the factory existed, batches `canExecute()` reads (groups of 10, to be gentle on the RPC provider), and for every vault that's due: fetches a real, executable route per target token from Squid (`quoteOnly: false`), simulates `executeStep(...)`, then broadcasts it.

```bash
# keeper/.env (never commit!)
KEEPER_PRIVATE_KEY=0x...
SQUID_INTEGRATOR_ID=...       # from https://app.squidrouter.com/
FACTORY_ADDRESS=0x31bF80a905EA80e0F8A9d6C20b44B0daa2A3f9f5

npm run keeper
```

### Automation via GitHub Actions

`.github/workflows/keeper.yml` runs `npm run keeper` every hour (`0 * * * *`) and supports manual triggering (`workflow_dispatch`). Requires three repository secrets:

| Secret | Value |
|---|---|
| `KEEPER_PRIVATE_KEY` | Keeper wallet private key (needs a small CELO balance for gas) |
| `SQUID_INTEGRATOR_ID` | Your Squid integrator ID |
| `FACTORY_ADDRESS` | `0x31bF80a905EA80e0F8A9d6C20b44B0daa2A3f9f5` |

Set them under **Settings → Secrets and variables → Actions**. Scheduled workflows only run off the repository's **default branch** — make sure that's the branch containing `.github/workflows/keeper.yml`.

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
