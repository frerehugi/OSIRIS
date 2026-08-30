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

## Governance: admin actions on the three vault factories are timelocked

As of **30.08.2026**, `onlyAdmin` actions on `DcaVaultFactory`, `TriggerVaultFactory`,
and `SendVaultFactory` (fee changes, admin transfer) go through an OpenZeppelin
`TimelockController` with a **48-hour delay**, deployed and verified at:

**`0xca177a126c95338271AFcfE691fD6efA37362460`** (Celo Mainnet)

Any proposed fee change is publicly visible on-chain 48h before it can take effect —
plan owners have a real window to notice and cancel their plan before an abusive change
would apply. The timelock's own `DEFAULT_ADMIN_ROLE` was renounced at deploy (set to
`address(0)`), so it can only govern itself through its own delayed `execute()` path.
Known limitation: the timelock's proposer role is currently a single EOA (the same
wallet that was the admin before) — the timelock adds delay and public visibility, it
does not by itself remove single-key risk from *proposing* a change. A move to a
multisig proposer is a separate, later item.

## Known, tracked risk areas

These are real, already-identified architectural trust assumptions and open findings —
tracked openly rather than hidden:

- **Fee administration (in progress)**: even with the timelock above, `minFee`
  currently has no absolute ceiling and is read live at every execution, so an
  already-funded plan's fee terms can still change after the fact (with 48h notice).
  The proper fix — snapshotting each plan's fee at setup time, plus an absolute `minFee`
  ceiling — is in progress, rolled out per vault type (DcaVault first, then SendVault,
  then TriggerVault), each deployed and observed separately rather than all at once.
- **Keeper trust for trigger plans**: `TriggerVault` stores `triggerPrice`/`triggerAbove`
  on-chain but does not verify them against a price oracle — the keeper decides
  off-chain whether to execute, and `minAmountOut` is keeper-supplied (only checked
  `> 0` on-chain). A compromised or malfunctioning keeper can execute at an unfavorable
  price. An on-chain floor derived from the vault's own `triggerPrice` (bounding, not
  eliminating, this risk) is planned as part of the TriggerVault fee-snapshot rollout.
- **Single keeper key**: the global keeper address is immutable per factory. If its key
  is lost or compromised, existing vault owners must authorize a new keeper themselves
  (`setKeeper()`, per-vault). A `setGlobalKeeper()` capability for new vaults going
  forward is planned alongside the fee-snapshot rollout above.
- **Access grants are not single-use**: an APIS access-grant code is valid, reusable,
  for its full chosen access window (up to 30 days) and read/propose-only — it cannot
  move funds or sign anything on its own. There is currently no way to revoke one early
  before it expires.

## Scope

In scope: `contracts/`, `keeper/`, `apis/backend`, `apis/app`, `src/`. Out of scope:
third-party infrastructure this project depends on but doesn't control (Squid Router,
Celo RPC providers, Cloudflare, MiniPay itself).
