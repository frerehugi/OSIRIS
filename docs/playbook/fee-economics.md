# Fee Economics: Does the Protocol Actually Cover Its Own Gas Cost?

The question that started this: "Does OSIRIS make net profit, or is the
CELO reserve slowly bleeding out?" — answered with real on-chain data, not
assumptions, using only standard `eth_getLogs`/`getBalance`/
`getTransactionReceipt` calls (no explorer API key, no indexer).

## Method (no indexer needed)

1. **Gross fee revenue:** every `executeStep()` charges its fee via an ERC20
   `Transfer(vault → treasury)`. Since the treasury address never receives
   stablecoins for any other reason, summing all `Transfer(to=treasury)`
   logs on the input-stablecoin contracts, from the fee mechanism's deploy
   block onward, gives exact gross revenue — no need to enumerate vaults or
   parse `FeeCharged` events per-vault.

2. **CELO converted so far:** the keeper's auto-refuel swaps show up as
   `Transfer(from=treasury)` on the same stablecoin contracts (paying into
   the router). Sum gives how much fee revenue has actually been turned
   into gas money vs. still sitting as unconverted stablecoin.

3. **Implied CELO/USD price — no external price feed needed:** CELO is
   native, so it has no ERC20 `Transfer` log. But for each refuel swap
   transaction, `balance_after - balance_before + gas_paid_in_that_tx`
   (via `getBalance` at the block before and at the swap block, plus that
   tx's own `gasUsed * effectiveGasPrice`) gives the exact CELO received.
   `stablecoin_in / celo_received` per swap gives a precise, self-sourced
   implied price at that moment — useful for converting gas costs (denominated
   in CELO) into the same USD terms as the fee revenue, without trusting any
   external price API.

4. **Total gas cost:** sum `gasUsed * effectiveGasPrice` over the receipts
   of every transaction found in step 1 and step 2's logs (covers both
   `executeStep` and refuel-swap transactions). Known gap: pure `approve()`
   calls don't emit a `Transfer` and so aren't in that tx-hash set — a
   deliberate, disclosed underestimate rather than a false precision.

5. **Break-even CELO price:**
   `gross_fee_revenue_usd / total_gas_cost_celo` — the price above which
   gas costs in USD exceed fee revenue, i.e. the protocol is running at a
   loss on average, at current volume/fee settings.

## What this actually found (useful as a sanity-check reference, numbers will drift)

- 58 fee-charging executions over ~67 days → **$1.32 total revenue**, in a
  regime almost entirely dominated by the fee **floor** ($0.02 at the time),
  not the percentage — small trade sizes mean `amount * feeBps` rarely beats
  the floor, so the floor *is* the effective fee for most executions.
- **10.39 CELO total gas cost** for those same executions → break-even price
  ≈ **$0.127/CELO**.
- The keeper's CELO balance had grown by +185 CELO over the period despite
  zero auto-refuels having triggered (revenue never crossed the $5/token
  threshold) — a dead giveaway that the balance growth was from a **manual
  top-up**, not the fee mechanism. A naive "current balance vs. starting
  balance" read would have wrongly concluded the protocol was healthy.
- Folding in real `approve()` gas costs (sampled from a separate wallet's
  actual on-chain `Approval` events, since the keeper itself had never
  called `approve()` yet) moved break-even from $0.1268 → $0.1262 — a
  **negligible** ~0.5% shift, because `approve()` costs ~1.4% of what a full
  `executeStep()` costs. Confirms it's fine to ignore approve-gas precision
  when the dominant cost is elsewhere — don't spend analysis effort where
  the sensitivity is low.
- At the actual live CELO price on the day this was checked ($0.063,
  roughly half of break-even), the *current* fee floor was already net
  profitable per-transaction — the earlier "bleeding" framing was specific
  to the historical window analyzed (which likely included a period of
  higher CELO price), not necessarily the current moment. **Always state
  which price the conclusion is conditioned on** — "profitable" or "losing
  money" is meaningless without pinning down the CELO price it's true at.
- Fee floor raised from $0.02 → $0.035 (via the factory's `setFee()`,
  admin-only, no redeploy) after this analysis — moved break-even to
  ~$0.195, roughly 3× the live price at the time, as a volatility buffer
  rather than a reaction to an active emergency.

## Reusable takeaways

- **A protocol's own treasury-wallet balance trend is not proof of health**
  — manual funding, or a price-dependent window, can make a structurally
  lossy fee schedule look fine by coincidence. Decompose into
  revenue-in / gas-out separately before trusting the balance delta.
- **State the CELO/USD price a profitability conclusion depends on**,
  explicitly — a break-even *price*, not a break-even *verdict*, is the
  right thing to compute and report, since the verdict flips with the
  market.
- **Getting exact on-chain financial answers doesn't require an indexer or
  API key** — `Transfer`/`Approval` event logs plus `getBalance` at specific
  historical blocks can reconstruct precise flows and even an implied price,
  entirely from a public RPC endpoint.
- Scripts: `keeper/feeAnalysis.ts` (revenue vs. gas, implied price) and
  `keeper/approveGasModel.ts` (folding in real approve-gas samples) —
  read-only, no private key needed, runnable via a throwaway
  `workflow_dispatch` GitHub Actions job (see `lessons-learned.md` §4 for
  why that's necessary instead of running locally in a sandboxed
  environment).
