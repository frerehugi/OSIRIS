# Architecture

## Per-user vault via factory clones, not a shared pool

`contracts/DcaVaultFactory.sol` deploys an EIP-1167 minimal-proxy clone of
`contracts/DcaVault.sol` per user (`createVault()`). Cheap to deploy, fully
isolated per user (no shared-pool accounting risk), and each vault only
trusts its own owner + the approved router + the global keeper.

Why not one shared contract with internal balances? Isolation: a bug or
exploit in one user's vault interaction can't touch another user's funds,
and cancel/withdraw logic stays trivial (`onlyOwner`).

## The vault never talks to a DEX directly

Earlier iterations called Uniswap-style routers directly from the vault.
Current design: the **keeper** fetches a fully-formed, executable route from
Squid's API (`quoteOnly=false`) off-chain, then calls
`vault.executeStep(routers[], minAmountsOut[], squidCallData[])`. The vault
only checks that each router is on an allowlist (`approvedRouters`) and that
the owner's balance of the target token increased by at least
`minAmountsOut[i]`. This keeps the on-chain contract simple and lets Squid's
route selection (fee tiers, pool choice, multi-hop) evolve without contract
changes.

## Multiple factories must be checked forever, not just the latest

When the factory was redeployed (e.g. for the fee-mechanism upgrade), old
vaults created via the previous factory don't disappear — they keep
running. The frontend (`src/minipayWallet.ts`) and keeper
(`keeper/squidKeeper.ts`) both query **all known factory addresses**
(`FACTORY_ADDRESS` + `OLD_FACTORY_ADDRESS` / comma-separated
`FACTORY_ADDRESSES`), never just the current one. There's also one true
standalone vault (`VAULT_ADDRESS`) that predates the factory entirely and
isn't discoverable via any factory's `getAllVaults()` — it's checked
separately, by address, forever (or until it finishes its last tranche).

**Takeaway for future projects:** any time a factory/registry contract gets
redeployed, decide explicitly whether old instances keep running — if so,
every piece of code that enumerates "all instances" needs the old address
kept in a list, not swapped out.

## Fee mechanism: treasury = keeper wallet, not a separate contract

`DcaVaultFactory.feeInfo()` returns `(feeBps, minFee, treasury)` where
`treasury` is hardcoded to the keeper's own address at construction. Every
`executeStep()` deducts the fee in the input stablecoin and sends it
straight to the keeper. The keeper then runs `autoRefuelCelo()` after each
cycle: if accumulated USDC or USDT (checked **separately per token**, not
combined) exceeds a threshold, it swaps a fixed percentage of it into CELO
via Squid, replenishing its own gas.

This makes the keeper self-funding without a separate treasury contract or
manual top-ups — but see `fee-economics.md` for why the fee level itself
still needs to be calibrated against real gas costs, not assumed.

**Open scaling item (2026-08-08):** cron currently fires hourly
(`0 * * * *` in `keeper/wrangler.toml`), so both vault-step execution and
the refuel check only happen once per hour. As transaction volume grows,
plan to reduce this to every 10 minutes (`*/10 * * * *`) so vaults execute
closer to their due time and refuel triggers faster once balances climb —
not urgent yet, but revisit once volume picks up.

`setFee(uint16 _feeBps, uint256 _minFee)` is `onlyAdmin`, hard-capped at
500 bps (5%) on the percentage but **uncapped on the floor** — a lightweight
lever for tuning economics post-launch without a redeploy.

## Platform-neutral keeper core

`keeper/squidKeeper.ts` never touches `process.env` directly — it takes an
`Env` object. `keeper/cli.ts` (Node/GitHub Actions) and `keeper/worker.ts`
(Cloudflare Worker cron) each build that `Env` from their own runtime and
call the same `runKeeperCycle()`. Worth doing this from day one if a keeper
might ever need to run somewhere other than where it started — which
happened here: GitHub Actions' `schedule:` trigger turned out to be
unreliable enough (see `lessons-learned.md`) that the production keeper
moved to the Cloudflare Worker entirely, reusing the exact same core logic.
