# Lessons Learned

Concrete problems hit while building/operating OSIRIS, and how they were
actually fixed — not the theory, the specific decision.

## 1. Public RPC `eth_getLogs` block-range limits are undocumented, differ per provider, and change over time

**Symptom:** "My Purchases" (scanning historical swap events) worked, then
started failing with vague "block range too large" errors from
`rpc.ankr.com` even after we'd already reduced the chunk size once by
guessing a smaller fixed number. Guessing a new fixed number is a trap —
the next provider or the same provider's next policy change breaks it again.

**Fix (`src/minipayWallet.ts`, `getSwapLogsChunked` / same pattern reused in
`keeper/feeAnalysis.ts`, `keeper/approveGasModel.ts`):** self-calibrating
chunk size. Start optimistic (`INITIAL_LOG_BLOCK_RANGE = 5_000n`), and on
any range-related error (matched via a broad `isBlockRangeError()` string
check — different providers phrase it differently: "block range", "range is
too large", "query returned more than", "limit exceeded", "too many
blocks"), halve the range and retry the *same* `start` block, never
advancing past a failed range. After a **success**, cautiously grow the
range back up (double it, capped at the initial value) — so a temporarily
stricter fallback provider doesn't permanently throttle every future scan
once a better one is available again.

```ts
while (start <= toBlock) {
  const end = min(start + range - 1, toBlock);
  try {
    const logs = await getLogs({ fromBlock: start, toBlock: end });
    allLogs.push(...logs);
    start = end + 1;
    if (range < INITIAL) range = min(range * 2, INITIAL); // ease back up
  } catch (error) {
    if (!isBlockRangeError(error) || range <= MIN) throw error;
    range = max(range / 2, MIN); // retry same start, smaller range
  }
}
```

Also: RPC fallback (`viem`'s `fallback([http(a), http(b)])`) helps with
transient outages of a single node, but does **not** solve the range-limit
problem by itself — different nodes in the fallback list can have different
limits, so the adaptive logic still needs to survive switching providers
mid-scan.

**Bounding the scan start, not just the range:** scanning from block 0 on a
chain with tens of millions of blocks is needlessly slow. Binary-search the
relevant contract's deploy block via `eth_getCode` (empty before deploy,
non-empty after) — ~27 RPC calls (`log2` of the chain height) instead of
scanning everything:

```ts
async function findDeploymentBlock(address) {
  let lo = 0n, hi = await getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await getCode({ address, blockNumber: mid });
    hi = code && code !== "0x" ? mid : hi;
    lo = code && code !== "0x" ? lo : mid + 1n;
  }
  return lo;
}
```
Cache the result — it never changes.

## 2. Re-scanning full history on every page load doesn't scale

**Symptom:** "My Purchases" took up to 3 minutes because it re-scanned
every swap event from the factory's deploy block on every load.

**Fix:** `localStorage`-backed incremental cache, keyed per vault
(`PURCHASES_CACHE_PREFIX + vaultAddress`), storing the last scanned block
plus already-resolved entries. Each load only scans from
`lastScannedBlock + 1` to `latest`, deduplicates by `txHash:logIndex`, and
only fetches block timestamps for genuinely new (null-timestamp) entries.
Include a `PURCHASES_CACHE_VERSION` constant in the cache key/shape so a
future schema change can invalidate old caches cleanly instead of crashing
on stale shapes. Wrap all `localStorage` reads/writes in try/catch — it can
throw (quota, private browsing, disabled storage) and must never break the
feature it's merely accelerating.

**The "3 years later, cleared cache" requirement:** don't assume the cache
exists. Cold-cache path (nothing in `localStorage`) must still work
correctly, just slower on that first load — it's the same code path with
`lastScannedBlock` defaulting to the contract's deploy block, not a special
case.

## 3. GitHub Pages custom domain SSL: both apex AND `www` must resolve correctly before Let's Encrypt issues *anything*

**Symptom:** custom domain (`osirisapp.xyz`, DNS bought/managed via Vercel)
kept showing "certificate invalid" in some wallets' in-app browsers days
after DNS looked correct.

**Root cause:** Vercel's default wildcard `*` ALIAS record was still
catching `www.osirisapp.xyz` and pointing it somewhere unrelated to GitHub
Pages. GitHub's own diagnostics literally said so
("`www.osirisapp.xyz` is improperly configured — InvalidARecordError") —
**check the exact error GitHub Pages shows before guessing.** GitHub won't
issue a cert for the apex domain at all until `www` is *also* correctly
pointed at `<user>.github.io.` (with the trailing dot), even if you don't
plan to use the `www` subdomain.

**Fix:** explicit `www CNAME frerehugi.github.io.` record, which overrides
the wildcard (more-specific records win over a wildcard ALIAS — true for
Vercel DNS specifically, verify per-provider). Then, if GitHub's cert
checkbox won't stay checked immediately after DNS looks right: that's
normal, cert provisioning lags DNS propagation by up to ~30–60 minutes —
retry rather than assuming something's still broken. If it's stuck for
longer, removing and re-adding the custom domain in GitHub Pages settings
restarts provisioning from scratch.

## 4. This kind of sandboxed dev environment usually has *no* general internet access

Outbound HTTPS from a Claude Code sandbox typically goes through a
allowlist-only proxy (npm/pypi/anthropic.com etc.) — arbitrary hosts like
`forno.celo.org`, `api.celoscan.io`, or the app's own production domain
return a 403 from the *proxy*, not the target server. `WebFetch` hits the
same wall for non-allowlisted hosts.

**Fix:** if you need real on-chain data, don't try to reach an RPC directly
from the sandbox — write the analysis script, commit it, and run it via a
throwaway `workflow_dispatch` GitHub Actions job (the same runners that
already run the production keeper *do* have real internet access), then
pull results back with the GitHub MCP tools (`actions_run_trigger` →
poll `list_workflow_runs`/`get_workflow_run` → `get_job_logs`). Delete or
keep the workflow afterward depending on whether it's reusable.

Practical gotchas from doing this twice (`keeper/feeAnalysis.ts`,
`keeper/approveGasModel.ts`):
- GitHub Actions jobs have a hard runtime cap (default 10 min in these
  workflows) — a naive "scan a wallet's *entire* transaction history"
  binary search can land on an unexpectedly old block (e.g. unrelated prior
  activity on a "fresh" test wallet) and blow the budget scanning tens of
  millions of irrelevant blocks. Bound the search to something you actually
  know is relevant (e.g. a contract's deploy block), not the wallet's raw
  first-ever activity.
- Fetching many transaction receipts sequentially is slow enough to matter
  at ~100+ transactions — parallelize with a small worker-pool
  (`mapWithConcurrency`, concurrency ~5–8), not `Promise.all` unbounded
  (rate limits) and not a plain `for` loop (too slow).
- A single missing/not-yet-indexed receipt (`TransactionReceiptNotFoundError`
  from one fallback RPC node lagging another) can crash an otherwise-working
  batch job. Catch per-item, skip and log, keep going — report "N/M
  succeeded" rather than failing the whole analysis over one flaky lookup.

## 5. Mobile in-app-browser WebViews don't fully support `accent-color` on `<input type="range">`

**Symptom:** slider track fill was correctly colored per-token
(`accent-color` did apply there), but the draggable thumb stayed plain
white in MiniPay's in-app browser regardless of the token color set via
`style={{ accentColor: TOKEN_COLOR[token] }}`.

**Fix:** don't rely on `accent-color` alone for the thumb specifically —
force it explicitly via `-webkit-appearance: none` on
`::-webkit-slider-thumb` (and `::-moz-range-thumb`), styling
`background`/`border-radius`/`width`/`height` by hand to match the
previous native appearance. Pass the color through as a CSS custom property
via inline `style` (`'--thumb-color': TOKEN_COLOR[token]`) since pseudo-
elements can't be targeted by React's inline `style` prop directly.
**Verify in the actual target WebView** (or at least a real WebKit engine),
not just a desktop browser — desktop Chrome/Firefox rendering `accent-color`
correctly told us nothing about MiniPay's embedded browser.

## 6. Keep all user-facing strings in one language — code comments can differ, error messages can't

This whole codebase's comments are (deliberately) German throughout, but
the actual UI and every string a user can see is English. It's easy for a
`throw new Error("...")` written while thinking in the comment-language of
the surrounding code to leak into production as user-visible text, since
nothing type-checks *language*. Found and fixed 11 instances after a user
screenshot showed one — worth grepping for the *whole* category
(`throw new Error("`, umlaut characters, common words like "fehlgeschlagen"/
"fehlt"/"ungültig") once you find the first one, not just fixing the one
reported.

## 7. Telegram link-preview selection in a multi-link message is not simply "first link wins"

With several links in one message, Telegram doesn't reliably preview the
first (or any predictable) one — and on iOS there's no visible "cycle
through available previews" control, only an X to dismiss the current one
(which then jumps to *some other* link, not necessarily the one you want).
Dismissing and re-editing an already-sent message can also get "stuck"
showing no preview at all, surviving further edits.

**Reliable fix:** put the one link you want previewed **alone** in its own
message, with the **explicit `https://` scheme** (bare domains like
`osirisapp.xyz` were less reliable at triggering a preview at all than
`https://osirisapp.xyz`). Send everything else as a separate follow-up
message where the preview choice doesn't matter. Don't try to fight
Telegram's algorithm inside one link-heavy message — split instead.

## 8. GitHub Actions' `schedule:` cron is not precise enough for a time-sensitive job

**Symptom:** an hourly `schedule: cron: "0 * * * *"` keeper job (needed
because vaults only offer whole-hour start times) was measured drifting
**2.6h–11.8h** between actual runs — GitHub explicitly does not guarantee
scheduled workflows fire on time, especially at popular times like the top
of the hour when every repo's cron piles up at once. This wasn't a fluke or
misconfiguration; it's documented, expected GitHub Actions behavior under
load.

**Fix:** ported the keeper to a **Cloudflare Worker with a native Cron
Trigger** (`keeper/worker.ts`, `keeper/wrangler.toml`) instead of trying to
tune the GitHub Actions schedule. Made cheap because the keeper's core
(`keeper/squidKeeper.ts`) was already platform-neutral (see
`architecture.md`) — the Workers entry point is ~25 lines. Confirmed fixed
via Cloudflare's own dashboard metrics: perfectly evenly-spaced hourly
invocation bars, 0 errors, over a 24h window — visibly different from the
erratic GitHub Actions pattern it replaced.

**Running both in parallel during the cutover — verified safe, but not
free:** for a few days both the old GitHub Actions cron and the new
Cloudflare Worker ran simultaneously (deliberately, as a validation
window) against the **same keeper wallet** (same `KEEPER_PRIVATE_KEY` on
both). Two things worth knowing before doing this yourself:
- **Fund safety:** confirmed safe by reading the contract, not by assuming.
  `DcaVault.executeStep()` updates `currentStep`/`nextExecutionTimestamp`
  *before* the external swap calls (checks-effects-interactions) and has
  `nonReentrant`. Two near-simultaneous keeper transactions can't both
  succeed — the blockchain sequences them, whichever lands first advances
  the state, and the second one reads the now-updated state and reverts
  (`TooEarly()`). No double-swap is possible even with two independent
  keepers racing.
- **Not free, though:** since both processes share one wallet, a genuine
  race (both fetching the same nonce before either tx is mined) can cause
  the loser to fail outright with a nonce error instead of a clean
  contract-level revert — that cycle's execution is simply skipped (no
  funds at risk, just a missed hourly run for that vault, self-resolving
  next cycle). Worth accepting for a short, deliberate cutover window;
  not something to leave running indefinitely. Once confirmed working,
  disable the old schedule (here: removed GitHub Actions' `schedule:`
  trigger, kept `workflow_dispatch` for manual/debug runs) rather than
  leaving both active.
