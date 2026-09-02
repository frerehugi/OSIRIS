# CELO Readme

Standing reference for OSIRIS/APIS and the surrounding Celo ecosystem — written so a
cold session (Claude or human) can get oriented without re-deriving it from scratch.

**Canonical copy:** this file is mirrored as a published Artifact —
[CELO Readme](https://claude.ai/code/artifact/ca88c8cc-7369-4920-9b84-cbf2ecb488ce) —
which is the version Claude reloads across unrelated chats when told "hold dir das
CELO readme". The two should stay in sync; if they drift, this file (checked into git,
reviewable in diffs) is the tiebreaker.

Last updated **02.09.2026**.

## 1. What this is

**OSIRIS** is a non-custodial DeFi vault app on **Celo Mainnet** (chain `42220`) built
for MiniPay users. It runs three kinds of automated plans through EIP-1167
minimal-proxy vault clones, swap-routed via **Squid Router**:

- **DCA** — recurring buys, one input token split into N tranches over time into one
  or more target tokens.
- **Send** — scheduled recurring payouts to one or more recipients.
- **Trigger** — a one-shot buy/sell that fires once a watched token crosses a price
  the user set (no on-chain oracle — see [§4](#4-security-posture)).

**APIS** is the AI agent layer on top: a chat interface (MCP-based) that reads
balances/plans and proposes transactions for the user to sign — it never holds keys or
signs on its own. It's also registering as an **ERC-8004** on-chain agent identity
(see [§9](#9-erc-8004-agent-identity--apiss-status)).

A Cloudflare Worker **keeper** polls every 5 minutes (cron `*/5 * * * *`) and calls
`execute()`/`executeStep()` on any vault whose on-chain `canExecute()` is true.

## 2. Architecture

| Path | Role |
|---|---|
| `contracts/` | Solidity — `DcaVault`/`SendVault`/`TriggerVault` + their factories. EIP-1167 clones; each factory's implementation is immutable once deployed. |
| `script/` | Foundry deploy scripts, one `Deploy*.s.sol` per factory generation. |
| `test/` | Foundry unit tests, 226 cases across 5 suites. Always verify with a real `forge test` run — this sandbox has no `lib/` submodules installed. |
| `keeper/squidKeeper.ts` | The Cloudflare Worker. Enumerates vaults across every known factory generation, checks `canExecute()`, and for Trigger plans additionally checks price against Squid's own `/token-price`. |
| `src/` | Shared config + wallet logic (`config.ts`, `minipayWallet.ts`) used by the OSIRIS MiniPay front end. |
| `apis/backend/` | The MCP server APIS exposes — plan reading, plan proposal, address book. |
| `apis/app/` | APIS chat front end (also re-exports `src/config.ts` addresses). |
| `erc7730/` | ERC-7730 "clear signing" descriptors for all six live vault contracts — pure off-chain metadata, no wallet confirmed to render them yet. |

Deploy target is Celo Mainnet only — this project deliberately does **not** test on
Celo Sepolia (Squid doesn't support it anyway); new deploys are verified with small
real amounts instead.

## 3. Live addresses

Current generation first, prior generations kept live underneath — every EIP-1167
clone points permanently at the implementation its factory deployed it with, so old
plans never migrate on their own. The keeper and the front end both enumerate *every*
generation below, never just the newest.

### DCA — `DcaVaultFactory`

| Gen | Factory | Implementation | Status |
|---|---|---|---|
| 3 (current) | `0xa6B66110b3593B5D32f4229CA5398611959149C5` | `0x02213a74a725C15EBbbC1212777b5b20C73B01E8` | live |
| 2 | `0xba148255d757912442A97f87c50DD2F65FBab7E0` | — | old, still served |
| 1 | `0x28f5E38C41F2cDB6D436972df5F3F42bD40Ed411` | — | old, still served |

Plus one pre-factory singleton vault, `VAULT_ADDRESS` =
`0x22541bDAf712920330F2d0FC26D1Ac807e914FDc`, deployed before any factory existed —
kept in the keeper's scan list by hand, not discoverable via `getAllVaults()`.

### Send — `SendVaultFactory`

| Gen | Factory | Implementation | Status |
|---|---|---|---|
| 2 (current) | `0x4d63381b9b742683b92971d672018Ec5d82DA002` | `0x2de1279b086cC0c642B8CFdbb702e014a81605d` | live |
| 1 | `0x1d7a157Bb1823482039B4B3037fb1737B1F2750A` | — | old, still served |

### Trigger — `TriggerVaultFactory`

| Gen | Factory | Implementation | Status |
|---|---|---|---|
| 2 (current) | `0x4398Cdd2AF617Bc36adBdF8a2BC60095535Bc625` | `0x8E3f4496303A2cC1C348Fca072EFc02aF587795f` | live, no floor on plans opened before 31.08.2026 |
| 1 | `0xeD39de472baEE17e6Ce05a0A4A0515eb4DF98a97` | — | old, still served |

Gen 3 (Plan 4 Befund A — per-token, decimals-aware `minFeeByToken` instead of
one global raw `minFee` scalar) is code-complete and tests-passing as of
02.09.2026 but **not yet deployed** — `src/config.ts`'s
`ALL_TRIGGER_VAULT_FACTORY_ADDRESSES` is deliberately structured as an
ever-growing list already, ready to take a third entry the moment it ships.
Also pending: `TriggerVaultFactory.setMaxSlippageBps(900)` was proposed via
the Timelock on 01.09.2026 for the *current* (gen 2) factory — fixes
`MinOutBelowFloor()` false-rejecting the keeper's own legitimate quotes —
executable ~48h later once the delay elapses.

### Shared infrastructure

| What | Address | Notes |
|---|---|---|
| Timelock (48h delay) | `0xca177a126c95338271AFcfE691fD6efA37362460` | Admin of all three current factories; own `DEFAULT_ADMIN_ROLE` renounced. Proposer is still a single EOA — known limitation, multisig proposer not yet done. |
| Squid Router | `0xce16F69375520ab01377ce7B88f5BA8C48F8D666` | |
| USDC (mainnet) | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | 6 decimals |
| USDT (mainnet) | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | 6 decimals |
| CELO (native ERC-20) | `0x471EcE3750Da237f93B8E339c536989b8978a438` | 18 decimals, same on mainnet + Sepolia |
| cUSD / "Mento Dollar" | `0x765DE816845861e75A25fCA122bb6898B8B1282a` | 18 decimals, not Squid-routable on mainnet yet |

Full token list (wBTC, wETH, XAUoT, Sepolia mocks) lives in `src/config.ts` — check
there before trusting a token address from memory.

## 4. Security posture

Source of truth is always `SECURITY.md` in the repo — this is a compressed pointer to
it, not a replacement.

- **Fee-snapshot + minFee ceiling** (current-gen factories only) — `feeBps`/`minFee`/
  `maxSlippageBps` are frozen into the plan at `setupPlan()`, not read live at
  execution, so a later admin fee change can't retroactively hit an existing plan.
- **`setGlobalKeeper()`** — keeper address is no longer `immutable` per factory. New
  vaults pick up the current keeper at `initialize()`; existing vaults stay frozen —
  owner's own `setKeeper()` is the per-vault recovery path.
- **Trigger: on-chain slippage floor** (new-gen only) — `execute()` rejects a
  keeper-supplied `minAmountOut` below a floor derived from the plan's own
  `triggerPrice`. Bounds — does not eliminate — a compromised/buggy keeper's damage.
  No price oracle exists anywhere in this system.
- **No audit yet** — 226 Foundry unit tests, no formal third-party audit, no bug
  bounty. Pre-audit is an explicit priority. Report vulnerabilities privately via
  `t.me/osirisapp`, never as a public issue.

### Trigger plans have no price oracle — worth internalizing

The on-chain `triggerPrice`/`triggerAbove` fields are informational only. The keeper
decides off-chain whether a plan is "due" by comparing them to **Squid's own
`/token-price`** — not Chainlink, not CoinGecko, not the price chart the app shows
next to the plan. Those two sources can and do diverge (observed live on 01.09.2026:
Squid quoted CELO ≈2% above CoinGecko for a stretch, silently stalling an
otherwise-ready plan — see `apis/app/src/components/TriggerPlanCard.tsx` for the
resulting UI caveat). If a trigger plan looks "obviously" overdue, check the keeper's
own price read (`wrangler tail`) before assuming a bug.

## 5. Keeper internals worth knowing cold

- **Multi-factory enumeration is mandatory.** Every factory generation above must stay
  in the keeper's scan list (env vars `FACTORY_ADDRESSES` / `SEND_VAULT_FACTORY_ADDRESSES`
  / `TRIGGER_VAULT_FACTORY_ADDRESSES`, comma-separated) — dropping an old address
  doesn't lose funds, but it makes existing plans silently invisible to execution.
- **Fee reads are snapshot-first, live-fallback.** The keeper tries
  `snapshotFeeBps()`/`snapshotMinFee()` first; a revert (older, pre-snapshot vault)
  falls back to that vault's own `factory()` address's live `feeInfo()` — never the
  currently-configured factory constant, which could be the wrong generation.
- **A single failing vault never aborts the cycle.** Both DCA and Trigger scan loops
  wrap each vault's checks in try/catch and log-and-continue — deliberate, learned the
  hard way (a silently-swallowed error used to look identical to "nothing to do").
- **Cloudflare Worker Observability (Logs/Traces) is currently Disabled** on the
  deployed worker — nothing persists after the fact. Live diagnosis needs
  `npx wrangler tail --format pretty` run from `keeper/` while waiting for the next
  5-minute tick, or the dashboard's Metrics tab for invocation/error counts only.

## 6. Dev & deploy workflow

| | |
|---|---|
| Branch → ship | Feature branch → fast-forward merge to `master` → direct push, no PR for this repo's normal flow. |
| Deploy (contracts) | Foundry `forge script`, dry-run then `--broadcast`, always run by the user locally (this sandbox has no `forge`/RPC egress) — reuse the existing deployer/keeper/Timelock keys, never mint new ones without being asked. |
| Deploy (frontend) | Push to `master` → user manually hits "Promote to Production" in Vercel for `apis/app` and `osiris`. |
| Deploy (keeper) | `cd keeper && npx wrangler deploy`, secrets via `npx wrangler secret put <NAME>`, local machine only. |
| Testing philosophy | Mainnet-only, no Sepolia dry runs (Squid doesn't support Sepolia anyway). Verify new deploys with small real amounts before trusting them with size. |
| Sandbox network reality | `forno.celo.org` and `celoscan.io` are both egress-blocked from this Claude Code sandbox. Live on-chain reads go through the user (Celoscan's mobile-friendly `#readContract` tab works with no wallet needed) or `cast`/`wrangler tail` run on their machine. |
| Test wallet | `0x205A92b7d69e2A0628cE928c4E3d3aC29D67C90f` |

**License, resolved:** `LICENSE` at repo root is proprietary/all-rights-reserved,
copyright exclusively **Schmitz & Hugenberg** — added 02.09.2026 on the
user's explicit instruction (not MIT, not the "University of Osnabrück"
holder an earlier unmerged branch (`claude/apis-8004-agent`, commit
`f7f463e`) had guessed at). That branch's separate "one-time code" → "access
code" UI copy fix was ported to `master` on its own merits earlier the same
day.

## 7. Hard-won gotchas

Specific, previously-costly mistakes — not general Solidity/TS advice.

- **Foundry `vm.expectRevert()` + an inline external call as an argument** consumes
  the cheatcode on that inline call instead of the enclosing one. Hoist any
  `factory.CONSTANT()`-style read to its own line before the guarded call.
- **Solidity `try/catch` around a call to a no-code address does not reliably catch a
  decode failure** under this project's solc/`via_ir` configuration — proven by a real
  failing test, not assumption. Guard with an explicit `extcodesize` check before
  trusting `try IERC20Metadata(token).decimals()`.
- **EIP-1167 clones never migrate.** Every factory's `vaultImplementation` is
  immutable — a contract fix always means a new implementation + new factory + an
  `OLD_*_ADDRESS` kept forever, on both the keeper and every place the front end lists
  a user's plans. Forgetting one call site makes existing plans vanish from "My Plans"
  without losing funds — check *every* factory-address call site on a migration, not
  just the obvious one.
- **A two-slot `[FACTORY_ADDRESS, OLD_FACTORY_ADDRESS]` pattern breaks on a *second*
  migration** — generation 1 quietly disappears. Use an ever-growing list
  (`ALL_FACTORY_ADDRESSES`) instead of two named slots once there's more than one
  prior generation.
- **A read helper that looks up derived data (e.g. a known-token table) before
  checking whether the underlying record is even initialized can silently drop
  the row instead of just rendering it incompletely.** Found live 02.09.2026:
  `usePlans.ts`'s `parseTriggerPlanRow()` resolved `heldToken`/`outputToken`
  against a symbol table before checking `initialized` — a pending vault
  (`createVault()` succeeded, `setupPlan()` never called) still has both at
  `address(0)`, the lookup failed, and the function returned `null` — so the
  vault vanished from *every* "My Plans" screen instead of showing as
  'pending' like its DCA equivalent already did. Always branch on
  initialization state first; only resolve derived fields once you know
  they're meaningful.
- **CI wasn't actually running the test suite.** `.github/workflows/tests.yml`
  (added 02.09.2026) is the first workflow that runs `forge test` + `tsc
  --noEmit` + `npm audit` on every push/PR — every prior verification in this
  project's history happened by hand, in a local terminal, never enforced. Its
  first real run also surfaced its own gotcha: `apis/app`/`apis/backend` both
  import shared code straight from root `src/` (no npm workspaces), so a
  matrix job that only runs `npm ci` inside its own package directory can't
  resolve root's own dependencies (`viem`) for those transitively-imported
  root files — install root deps too, not just the matrix package's own.

## 8. Celopedia skill

The `celopedia-skill` is the standing reference for live Celo ecosystem facts:
verified contract/token addresses, DeFi protocol directory, MiniPay dev specifics,
AI-agent infrastructure (ERC-8004, x402), governance, grants, and cross-chain
migration guidance (Lisk/Base/Optimism/Mode/Ink/Unichain/Soneium/Zora/Fraxtal → Celo).
It's backed by live data via The Grid — **invoke it rather than answering ecosystem
questions from training-data memory**, especially anything address- or
protocol-status-shaped, which goes stale fast.

## 9. ERC-8004 agent identity — APIS's status

| | |
|---|---|
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (Celo Mainnet) |
| APIS Agent ID | `9795` — minted |
| Attribution tag | `celo_6b8b070e35df` — live in `src/config.ts`, appended as `dataSuffix` on every `writeContractAsync` call in `apis/app/src/screens/ConfirmPlan.tsx`, wrapped in try/catch so a bad tag degrades to no-suffix instead of crashing the confirm screen. |
| Registration flow, decoupled | The attribution tag comes from **Celo Builders** registration (derived from the GitHub `owner/repo` slug), independent of the 8004 mint — don't assume one gates the other. See §10. |
| Agent registration file | Served as `apis/app/public/.well-known/agent.json` — must use `services` (not `endpoints`), and its MCP endpoint must be the real MCP worker (`apis-backend.frerehugi.workers.dev`), never the frontend domain. |

## 10. Celo Builders (hackathon / attribution tag)

Use the `celo-builders` skill for the live API contract — it changes, don't hardcode
assumptions from a past session. Structural facts worth keeping:

- Registration ≠ publish. A draft is saved via `PUT /submissions/me` and stays private
  until an explicit `POST /submissions/me/publish` — never publish without showing the
  user the full draft first.
- Track/bounty slugs must always be read live from `/hackathons/<slug>/tracks` /
  `/bounties` — a guessed or stale slug is rejected outright.
- The attribution tag returns immediately on minimal registration; it does not
  require an 8004 agent ID first.

## 11. x402 payments

`x402.celo.org` is Celo's agent-payments protocol infrastructure — not yet explored in
depth in this project's sessions (the domain is also egress-blocked from this
sandbox, so nothing here has been independently verified against live docs). Treat
anything about it as unresearched until pulled fresh via the celopedia skill or a
session with real network access — don't extrapolate details from this doc.

## 12. Reading & updating this doc

How a cold session gets this back, and how to keep it honest.

1. **To load it:** either read this file directly if the OSIRIS repo is attached, or
   (from a chat without repo access) call the Artifact tool with `action: "list"`,
   find the one titled *CELO Readme*, then `action: "read"` with its URL.
2. **To update it:** edit this file *and* republish the Artifact (read it first, edit,
   `action: "publish"` with the same `url`, no new `favicon`) — keep both in sync, and
   bump the "Last updated" date in both.
3. **What belongs here:** durable, structural facts a fresh session would otherwise
   have to re-derive — live addresses, architecture, security posture, conventions,
   ecosystem pointers, and gotchas specific enough to have actually cost time once.
   **What doesn't:** anything that's really just today's task status, a one-off bug's
   blow-by-blow, or a fact that decays fast enough to be wrong by the time it's read
   (check `SECURITY.md` / `src/config.ts` in the repo for those — this page points at
   them rather than duplicating them where it can).
4. **Trigger phrase:** the user says "hold dir das CELO readme" (or similar) to mean:
   go get this context before doing anything else in the conversation.

---

Maintained by Claude across sessions on the `frerehugi/OSIRIS` project. Not a
substitute for reading the actual repo — `SECURITY.md`, `src/config.ts`, and the code
itself always win on a conflict.
