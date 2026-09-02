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
- Test coverage: 226 Foundry unit tests across five suites (`test/*.t.sol`), covering
  setup validation, execution, slippage/router/failure guards, cancellation, expiry,
  fee-on-transfer handling, factory clone creation, fee-snapshot behavior, `minFee`
  ceilings, keeper rotation, and (for `TriggerVault`) exact slippage-floor boundary
  tests and the direction-invariant guards described below. Mostly unit tests — one
  fuzz test, no invariant tests yet.
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

## Fee-snapshot, `minFee` ceiling, and keeper rotation — live for all three vault types

As of **31.08.2026**, `DcaVaultFactory`, `SendVaultFactory`, and `TriggerVaultFactory`
were redeployed (new implementation + new factory each, admin set directly to the
Timelock above at deploy time — no intermediate EOA-admin window) with:

- **Fee snapshot**: `feeBps`/`minFee` (and, for `TriggerVault`, `maxSlippageBps`) are
  read once at plan setup and frozen for that plan's lifetime, instead of being read
  live at every execution. A subsequent admin fee change — even a legitimate,
  timelocked one — now only applies to plans created after it; an already-funded plan
  keeps the terms it was set up under.
- **Absolute `minFee` ceiling**: on top of the existing 5% `feeBps` cap, `minFee` (a
  fixed token amount, not a percentage) now has a hard ceiling too, so it can no
  longer be raised to a level that would functionally confiscate a small tranche.
- **`setGlobalKeeper()`**: the keeper address is no longer immutable per factory — if
  the keeper key is lost or compromised, the admin (Timelock, 48h delay) can point new
  vaults at a new keeper without a contract redeploy. This only affects vaults created
  after the change; existing vaults keep their own frozen keeper set at
  `initialize()`, with the owner's own `setKeeper()` remaining the per-vault recovery
  path.
- **`TriggerVault` only — on-chain slippage floor + direction invariant**:
  `setupPlan()` now requires `watchToken` to be one of the two held/output legs and
  `triggerAbove` to match which leg is held, restricting new plans to the two
  directions (dip-buy, take-profit-sell) the app actually offers. The non-watched leg
  must be on a new admin-maintained stablecoin allowlist. `execute()` now rejects a
  keeper-supplied `minAmountOut` below a floor derived from the plan's own
  `triggerPrice` and a capped `maxSlippageBps` tolerance — this bounds, but does not
  eliminate (still no price oracle), how unfavorable a price a compromised or
  malfunctioning keeper can execute at.

Current addresses:

| Vault type | Factory | Implementation |
|---|---|---|
| DCA | `0xa6B66110b3593B5D32f4229CA5398611959149C5` | `0x02213a74a725C15EBbbC1212777b5b20C73B01E8` |
| Send | `0x4d63381b9b742683b92971d672018Ec5d82DA002` | `0x2de1279b086cC0c642B8CFdbb702e014a81605d` |
| Trigger | `0xE19f7267A7F4CC7a4e4c6fc6967d2B5F25Ab09ed` | `0x741Fad235EC4808c8C06279b1D1c8E578fc6A635` |

**Important limitation**: this protection applies only to plans created on the new
factories above. EIP-1167 clones delegate permanently to the implementation address
their factory deployed them with — there is no proxy-admin upgrade path. Any plan
still open on an older factory generation (tracked as `OLD_FACTORY_ADDRESS` /
`OLD_SEND_VAULT_FACTORY_ADDRESS` / `OLD_TRIGGER_VAULT_FACTORY_ADDRESS` in
`src/config.ts`) keeps running on the old, unprotected terms for the rest of its
life — live fee reads, no `minFee` ceiling, and for `TriggerVault`, no slippage floor
at all. Owners of an open plan on an old `TriggerVaultFactory` who want the new floor
need to cancel and recreate their plan.

## Second review (01.09.2026) — findings and fixes

A second external review, against the code above, found two real gaps this
project's own tooling introduced and missed, plus confirmed one already-known
issue was live in production. All three are fixed as of this section:

- **Keeper safety buffer vs. the new Trigger slippage floor (fixed via
  Timelock)**: the keeper's own pre-existing safety margins (Squid's 5% quote
  slippage tolerance, plus an additional 3% buffer the keeper applies on top)
  combine to roughly 7.85% below fair value in the worst case — comfortably
  more than the 2% the slippage floor above allowed, so it rejected the
  keeper's own legitimate `minAmountOut` with `MinOutBelowFloor()` on live
  plans. `TriggerVaultFactory.setMaxSlippageBps(900)` (2% → 9%, still well
  under the 20% hard cap) was proposed via the Timelock on 01.09.2026 for
  that generation (`0x4398Cdd2AF617Bc36adBdF8a2BC60095535Bc625`), executable
  ~48h later once the delay elapses. Its `snapshotMaxSlippageBps` is frozen
  per plan at setup, so a plan created before the change keeps its old 2%
  tolerance and needs to be cancelled and recreated to benefit. **The
  Plan 4 Befund A factory deployed 02.09.2026
  (`0xE19f7267A7F4CC7a4e4c6fc6967d2B5F25Ab09ed`, now current) has the exact
  same gap** — its constructor hardcodes the same `maxSlippageBps = 200`
  default, and the deploy script cannot raise it itself (`onlyAdmin` = the
  Timelock). A separate `setMaxSlippageBps(900)` proposal for this address
  is still needed and has not been made as of this writing — do this before
  any real Sell-direction plan is created on it.
- **APIS' plan compiler didn't enforce the new stablecoin requirement (fixed)**:
  `planCompiler.ts`'s sell-trigger validation predates the slippage-floor
  work above and never got the matching `StablecoinRequired()` check — it
  would validate e.g. "sell wBTC for wETH" as a valid plan, when the deployed
  contract rejects it. A plan could get as far as creating and approving a
  vault before failing at `setupPlan()`. Fixed in `planCompiler.ts`, the MCP
  tool's schema (`server.ts`), and the REST/OpenAPI schema (`openapi.ts`), so
  all three entry points (Claude via MCP, ChatGPT/Gemini/Grok via REST) now
  match the contract.
- **`TriggerVault`'s `minFee` wasn't decimals-aware (fixed, new factory
  generation, deployed and verified 02.09.2026)**: `minFee` was a single
  global raw value (`35_000`), implicitly
  assuming a 6-decimal stablecoin — but for a Sell-direction plan, `heldToken`
  is the crypto asset itself (wBTC=8, wETH/CELO=18, XAUoT=6 decimals). A
  small wBTC sell could see an effective fee near 35% instead of the nominal
  0.99%. Fixed the same way `SendVaultFactory` already handles this
  (`minFeeByToken` mapping, one value per token, decimals-scaled cap via
  `setMinFee(address, uint256)`) — `feeInfo()`'s signature was deliberately
  left unchanged for keeper-ABI compatibility across factory generations; new
  plans read their fee via `minFeeByToken(heldToken)` directly instead.
  **Residual limitation, not fully solved by this fix**: the cap itself
  (`MAX_MIN_FEE_WHOLE_UNITS = 5`, "5 whole token units") is generous for an
  expensive token like wBTC — same limitation the review separately pointed
  out already exists in `SendVaultFactory`. Without a price oracle, a single
  admin-calibrated raw value per token is the best available fix; it's
  strictly better than the previous fully unbounded scalar, not a precise
  dollar-denominated cap.

The review also re-confirmed one point with real production evidence rather
than just static analysis: **the keeper does scan every known Trigger factory
generation** (verified via a live `wrangler tail` session showing both the old
and current `TriggerVaultFactory` addresses in its scan list) — the review
had flagged this as unverifiable from outside, not as a confirmed gap.

## Known, tracked risk areas

These are real, already-identified architectural trust assumptions and open findings —
tracked openly rather than hidden:

- **Fee administration (addressed for new plans)**: fee-snapshot and an absolute
  `minFee` ceiling are live for all three vault types as of 31.08.2026 — see the
  section above. Plans still open on an older factory generation are unaffected by
  this fix and remain on the old, live-read, uncapped terms.
- **Keeper trust for trigger plans (bounded, not eliminated)**: `TriggerVault` still
  has no price oracle — the keeper decides off-chain whether/when to execute. New
  plans now get an on-chain slippage floor derived from the plan's own `triggerPrice`
  (see the section above), which bounds how unfavorable a price a compromised or
  malfunctioning keeper can execute at, but doesn't eliminate the underlying trust
  assumption. Plans on the old `TriggerVaultFactory` have no floor at all.
- **Single keeper key (mitigated for new vaults)**: `setGlobalKeeper()` now lets the
  admin (Timelock) rotate the keeper for vaults created going forward without a
  contract redeploy — see the section above. Existing vaults still freeze their
  keeper at creation; their owner's own `setKeeper()` remains the recovery path.
- **Access grants are not single-use (deliberate, not an oversight)**: an APIS
  access-grant code is valid, reusable, for its full chosen access window (up to 30
  days) and read/propose-only — it cannot move funds or sign anything on its own.
  Re-flagged by the second review; still deliberately unchanged: a real one-time
  nonce would mean a connected AI could only ever propose a single plan or read
  balances once per grant, breaking the access-grant model's actual purpose (a
  standing connection an AI assistant can use repeatedly within a bounded window).
  There is currently no way to revoke one early before it expires — this specific
  gap (early revocation) is a real, open limitation worth closing, distinct from the
  reusability itself.
- **`GET /address-book/for-owner?owner=0x...` requires no grant code at all
  (deliberate, not an oversight — but read this precisely)**: this specific REST
  endpoint — used by the OSIRIS app's own Address Book screen to show a connected
  wallet its own contacts — takes a raw `owner` address with no authentication
  whatsoever. It is not listed in the AI-facing OpenAPI spec and no MCP tool calls
  it (the AI-facing paths, `get_address_book` and `POST /address-book`, both do
  require a grant code with 'read' access) — but the endpoint itself is public on
  the open internet, so anyone who knows or guesses a wallet address, not only a
  connected AI holding a valid grant, can read that wallet's saved contact names.
  The wallet address itself is not secret (public on every on-chain transaction the
  vaults make); the contact names attached to it are the actual additional
  information this exposes. Deliberately unchanged for now — re-flagged by the
  second review, and the option to fix it (e.g. require the wallet's own signature,
  same pattern as `contactSignature.ts` already uses for writes) is real and not
  large; revisit if this needs tightening.

## Scope

In scope: `contracts/`, `keeper/`, `apis/backend`, `apis/app`, `src/`. Out of scope:
third-party infrastructure this project depends on but doesn't control (Squid Router,
Celo RPC providers, Cloudflare, MiniPay itself).
