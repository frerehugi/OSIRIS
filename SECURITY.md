# Security Policy

OSIRIS/APIS manages real, non-custodial DeFi vaults on Celo Mainnet. If you find a
security issue — in the smart contracts (`contracts/`), the keeper (`keeper/`), or the
APIS agent layer (`apis/`) — please report it responsibly.

## Reporting a vulnerability

Do **not** open a public GitHub issue for a security vulnerability.

Instead, reach out privately via the OSIRIS Telegram group: **t.me/osirisapp** — this is
the project's only official point of contact (see the in-app About/Terms/Privacy
screens). Describe the issue, the affected contract/file, and, if possible, steps to
reproduce or a proof of concept. We'll acknowledge receipt and work with you on a fix
and a disclosure timeline before any public write-up.

## Current status

Honest snapshot, not a claim of completeness:

- **No formal, independent third-party audit has been completed yet.** This is
  explicitly a pre-audit priority (see the open contract-level findings below).
- **No bug bounty program exists yet.**
- Test coverage: 177 Foundry unit tests across five suites (`test/*.t.sol`), covering
  setup validation, execution, slippage/router/failure guards, cancellation, expiry,
  fee-on-transfer handling, and factory clone creation. Mostly unit tests — one fuzz
  test, no invariant tests yet.
- `npm audit --omit=dev` across the three JS/TS packages (root, `apis/backend`,
  `apis/app`) currently reports no known production-dependency vulnerabilities — that's
  a point-in-time check, not a substitute for a real audit.

## Known, tracked risk areas

These are real, already-identified architectural trust assumptions and open findings —
tracked openly rather than hidden:

- **Fee administration**: `feeBps` is capped at 5% on-chain, but `minFee` currently has
  no upper bound and is read live at every execution — an admin key compromise could
  raise it well past the declared cap on already-funded plans. Being addressed (see
  repository history/PRs for the fix in progress).
- **Keeper trust for trigger plans**: `TriggerVault` stores `triggerPrice`/`triggerAbove`
  on-chain but does not verify them against a price oracle — the keeper decides
  off-chain whether to execute, and `minAmountOut` is keeper-supplied (only checked
  `> 0` on-chain). A compromised or malfunctioning keeper can execute at an unfavorable
  price. Reducing this trust dependency is an open, tracked item.
- **Single keeper key**: the global keeper address is immutable per factory. If its key
  is lost or compromised, existing vault owners must authorize a new keeper themselves
  — there's no centralized rotation mechanism yet.
- **Access grants are not single-use**: an APIS access-grant code is valid, reusable,
  for its full chosen access window (up to 30 days) and read/propose-only — it cannot
  move funds or sign anything on its own. There is currently no way to revoke one early
  before it expires.

## Scope

In scope: `contracts/`, `keeper/`, `apis/backend`, `apis/app`, `src/`. Out of scope:
third-party infrastructure this project depends on but doesn't control (Squid Router,
Celo RPC providers, Cloudflare, MiniPay itself).
