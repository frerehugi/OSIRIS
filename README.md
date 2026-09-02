# OSIRIS / APIS

**OSnabrück Investment and Risk Management System**

A non-custodial DeFi vault app on **Celo Mainnet**, built for [MiniPay](https://www.opera.com/products/minipay) users. Every plan runs through its own dedicated EIP-1167 minimal-proxy vault clone — created on demand through a factory contract — and swaps route exclusively through [Squid Router](https://www.squidrouter.com/), which sources liquidity across DEXs on Celo instead of relying on a single fixed pool.

**APIS** is the AI agent layer on top: a separate companion app that lets you connect an AI assistant (Claude, ChatGPT, Gemini, Grok, or any MCP-/REST-capable client) to read your balances and plans and *propose* transactions — it never holds your keys or signs anything on its own. Every proposed transaction still needs your explicit approval in MiniPay.

🔴 **Live on Celo Mainnet** — [app.osirisapp.xyz](https://app.osirisapp.xyz) (OSIRIS vaults) · [apis.osirisapp.xyz](https://apis.osirisapp.xyz) (APIS agent connector) · [osirisapp.xyz](https://osirisapp.xyz) (landing page)

---

## What it does

Three kinds of automated, non-custodial plans, each its own vault type:

- **DCA** (`DcaVault`) — recurring buys: one input stablecoin split into N tranches over time, into a self-chosen basket of target tokens (wBTC, wETH, CELO, XAUoT).
- **Send** (`SendVault`) — scheduled recurring payouts to one or more recipients.
- **Trigger** (`TriggerVault`) — a one-shot buy or sell that fires once a watched token's price crosses a level you set. No on-chain price oracle — the keeper compares against Squid's own live quote (see [Security](#security) below).

A keeper service polls every 5 minutes and calls `executeStep()`/`execute()` on any vault whose on-chain `canExecute()` is true — the vault itself only ever checks that the resulting balance increase meets the caller-supplied minimum; it never inspects *what* the swap calldata does, which decouples the vault from any specific DEX.

---

## Architecture

```
OSIRIS/
├── contracts/
│   ├── DcaVault.sol / DcaVaultFactory.sol         # Recurring-buy vault (EIP-1167 clone)
│   ├── SendVault.sol / SendVaultFactory.sol       # Recurring-payout vault
│   └── TriggerVault.sol / TriggerVaultFactory.sol # One-shot price-trigger vault
├── script/                       # Foundry deploy scripts — one Deploy*.s.sol per factory generation
├── test/                         # Foundry unit tests — 226 cases across 5 suites (see Testing below)
├── erc7730/                      # ERC-7730 "clear signing" descriptors for all six vault contracts
├── keeper/
│   ├── squidKeeper.ts            # Core logic — enumerates every known factory generation, checks
│   │                              #  canExecute(), fetches routes/prices from Squid, executes
│   ├── worker.ts                 # Cloudflare Worker entry point (production — 5-minute cron)
│   ├── cli.ts                    # Local/manual entry point (npm run keeper)
│   └── price.sh                  # Terminal one-liner to print current Squid token prices
├── src/                          # OSIRIS front end (React) — connect, "My Plans", DCA/Send/Trigger wizards
│   ├── config.ts                 # Chain ID, contract + token addresses (single source of truth)
│   ├── minipayWallet.ts          # MiniPay / viem wallet integration, shared by src/ and apis/
│   └── *VaultAbi.ts              # Contract ABIs
├── apis/
│   ├── backend/                  # Cloudflare Worker — MCP server + parallel REST/OpenAPI layer,
│   │                              #  so both MCP clients (Claude) and non-MCP clients
│   │                              #  (ChatGPT/Gemini/Grok) can read plans/balances and propose plans
│   └── app/                      # APIS front end (React) — connect an AI assistant, generate access
│                                  #  codes, address book, approve proposed plans in MiniPay
├── docs/                         # MiniPay listing checklist, playbook notes
├── SECURITY.md                   # Current security posture, known/tracked risk areas
└── .github/workflows/            # tests.yml (forge test + typecheck + audit), keeper.yml, gas-model checks
```

Both front ends (`src/`, `apis/app/`) and the backend (`apis/backend/`) import shared config/ABI/wallet logic straight from root `src/` rather than a published package — there are no npm workspaces, so each of the three JS/TS packages (root, `apis/app`, `apis/backend`) needs its own `npm install`.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Smart Contracts | Solidity `^0.8.20`, OpenZeppelin (Clones, SafeERC20, ReentrancyGuard, TimelockController) |
| Vault Pattern | EIP-1167 minimal-proxy clones — one cheap clone per plan via a factory; immutable implementation per factory generation |
| Routing | Squid Router v2 (exclusive — no direct DEX integration) |
| OSIRIS front end (`src/`) | React 18, TypeScript, Vite |
| APIS front end (`apis/app/`) | React 19, TypeScript, Vite, wagmi, TanStack Query |
| APIS backend (`apis/backend/`) | Cloudflare Workers, `@modelcontextprotocol/sdk` (MCP), Zod |
| Wallet | MiniPay (Celo), viem v2 |
| Keeper | TypeScript, Cloudflare Workers (production, 5-minute cron), viem, axios |
| Testing | Foundry (`forge test`) |
| CI | GitHub Actions — `forge test`, `tsc --noEmit` × 3 packages, `npm audit` on every push/PR |
| Network | Celo Mainnet only — Squid does not support Celo Sepolia, so this project deliberately does not test on testnet |

---

## Setup

Three independent packages — no npm workspaces, so each needs its own install.

```bash
# OSIRIS front end + contracts/keeper tooling (root)
npm install
npm run dev          # → http://localhost:5173
npm run typecheck
npm run build         # outputs to dist/

# APIS front end
cd apis/app && npm install
npm run dev
npm run typecheck

# APIS backend (Cloudflare Worker — MCP + REST/OpenAPI)
cd apis/backend && npm install
npm run dev            # wrangler dev
npm run typecheck
```

`src/config.ts` already contains the live Mainnet addresses (factories, implementations, Squid Router, token list) — the single source of truth both front ends and the backend re-export from. If you deploy your own instance, update the addresses there after running the deploy scripts below.

---

## Smart Contracts

### How it works

1. `<X>VaultFactory.createVault()` clones the relevant vault implementation (EIP-1167) and initializes it in the same transaction — no constructor, no front-running window.
2. The owner approves the new vault address for the input token, then calls `setupPlan(...)` on it directly. `feeBps`/`minFee` (and, for Trigger, `maxSlippageBps`) are snapshotted into the plan at this point — a later admin fee change never retroactively affects an already-funded plan.
3. A keeper calls `executeStep(...)` / `execute(...)` once a tranche/trigger condition is due. The vault only checks that the resulting balance increase meets the keeper-supplied minimum — it never inspects the swap calldata itself.

### Deploy (Celo Mainnet)

```bash
forge script script/DeployFactory.s.sol --rpc-url celo_mainnet --broadcast --verify -vvvv
forge script script/DeploySendVaultFactory.s.sol --rpc-url celo_mainnet --broadcast --verify -vvvv
forge script script/DeployTriggerVaultFactory.s.sol --rpc-url celo_mainnet --broadcast --verify -vvvv
```

Each deploys a new implementation + factory pair and verifies both on Celoscan. Because EIP-1167 clones delegate permanently to the implementation address their factory deployed them with, every migration keeps the previous generation's address alongside the new one — old plans keep running under their original terms rather than disappearing.

### Live addresses (Celo Mainnet, chain ID `42220`)

Current generation first; every prior generation is still live and still served by the keeper and both front ends — nothing here is ever removed, only appended to (see `src/config.ts`'s `ALL_*_ADDRESSES` arrays).

**DCA — `DcaVaultFactory`**

| Gen | Factory | Implementation |
|---|---|---|
| 3 (current) | `0xa6B66110b3593B5D32f4229CA5398611959149C5` | `0x02213a74a725C15EBbbC1212777b5b20C73B01E8` |
| 2 | `0xba148255d757912442A97f87c50DD2F65FBab7E0` | — |
| 1 | `0x28f5E38C41F2cDB6D436972df5F3F42bD40Ed411` | — |

Plus one pre-factory singleton vault (`0x22541bDAf712920330F2d0FC26D1Ac807e914FDc`), deployed before any factory existed.

**Send — `SendVaultFactory`**

| Gen | Factory | Implementation |
|---|---|---|
| 2 (current) | `0x4d63381b9b742683b92971d672018Ec5d82DA002` | `0x2de1279b086cC0c642B8CFdbb702e014a81605d` |
| 1 | `0x1d7a157Bb1823482039B4B3037fb1737B1F2750A` | — |

**Trigger — `TriggerVaultFactory`**

| Gen | Factory | Implementation |
|---|---|---|
| 2 (current) | `0x4398Cdd2AF617Bc36adBdF8a2BC60095535Bc625` | `0x8E3f4496303A2cC1C348Fca072EFc02aF587795f` |
| 1 | `0xeD39de472baEE17e6Ce05a0A4A0515eb4DF98a97` | — |

**Governance & routing**

| What | Address |
|---|---|
| Timelock (48h delay, admin of all current factories) | `0xca177a126c95338271AFcfE691fD6efA37362460` |
| Squid Router | `0xce16F69375520ab01377ce7B88f5BA8C48F8D666` |

### Testing

```bash
forge test -vvv
```

226 Foundry tests across five suites (`DcaVault.t.sol`, `DcaVaultFactory.t.sol`, `SendVault.t.sol`, `SendVaultFactory.t.sol`, `TriggerVault.t.sol`), covering setup validation, execution, slippage/router/failure guards, cancellation, expiry, fee-on-transfer handling, factory clone creation, fee-snapshot behavior, `minFee` ceilings, keeper rotation, and (Trigger) exact slippage-floor boundaries and direction-invariant guards. `.github/workflows/tests.yml` runs the full suite plus `tsc --noEmit` and `npm audit` across all three JS/TS packages on every push and PR.

---

## Keeper Service

The keeper enumerates every known factory generation (never just the current one), batches `canExecute()` reads, and for every vault that's due: fetches a real, executable route from Squid, simulates the call, then broadcasts it. Trigger plans additionally compare the watched token's live Squid `/token-price` against the plan's stored `triggerPrice`/`triggerAbove`.

Production runs as a Cloudflare Worker on a 5-minute cron (`keeper/worker.ts`); `keeper/cli.ts` is the equivalent local/manual entry point.

```bash
# keeper/.env (never commit!)
KEEPER_PRIVATE_KEY=0x...
SQUID_INTEGRATOR_ID=...       # from https://app.squidrouter.com/

npm run keeper
```

`keeper/price.sh` prints current Squid token prices from the terminal without needing the full keeper running.

---

## APIS — the AI agent layer

`apis/backend` is a Cloudflare Worker exposing the same capabilities two ways so both MCP clients (Claude) and non-MCP clients (ChatGPT, Gemini, Grok, or anything that can call a REST/OpenAPI endpoint) can use them: reading balances and plans, proposing a new plan or a direct send, reading/writing the address book, and reading current Squid token prices. It never holds a private key and never signs anything — every proposal comes back to `apis/app` for the wallet owner to review and approve in MiniPay.

Connecting an assistant: open `apis/app`, connect your wallet, add APIS as a tool/connector in your AI client once, then generate an access code (`apis/app`'s "Create New Code for Agent" screen) and paste it into that chat — the code is a self-contained, signed message valid for your chosen window (up to 30 days), not a stored credential; APIS' backend never saves it.

---

## Token Addresses (Celo Mainnet)

| Token | Address | Role | Decimals |
|---|---|---|---|
| USDC | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | Input | 6 |
| USDT | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | Input | 6 |
| cUSD ("Mento Dollar") | `0x765DE816845861e75A25fCA122bb6898B8B1282a` | Input — ⚠️ not currently routable via Squid | 18 |
| wBTC | `0x8aC2901Dd8A1F17a1A4768A6bA4C3751e3995B2D` | Target | 8 |
| wETH | `0xD221812de1BD094f35587EE8E174B07B6167D9Af` | Target | 18 |
| CELO | `0x471EcE3750Da237f93B8E339c536989b8978a438` | Target | 18 |
| XAUoT | `0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff` | Target — "XAUt0" (Tether Gold) on Squid | 6 |

Full/authoritative list always lives in `src/config.ts` — check there before trusting an address from this table.

---

## Security

See [`SECURITY.md`](./SECURITY.md) for the honest current-status snapshot: no formal third-party audit yet, the fee-snapshot/`minFee`-ceiling/keeper-rotation protections and what they do and don't cover, why Trigger plans have no price oracle (the keeper compares against Squid's own live quote, not Chainlink or a fixed feed), and the other known, deliberately-tracked risk areas. Report a vulnerability privately via `t.me/osirisapp` — never as a public GitHub issue.

---

## License

No `LICENSE` file exists in this repository yet, and no license has been finalized — treat the code as all-rights-reserved until one is added.

---

## Contact

Support / updates: [t.me/osirisapp](https://t.me/osirisapp)
