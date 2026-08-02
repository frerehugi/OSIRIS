# Wallet Strategy: Supporting Multiple Mobile Crypto Wallets Safely

Written after being asked: "OSIRIS is built and configured for MiniPay —
how do we also let Trust Wallet, Valora etc. users in, without changing or
endangering the existing MiniPay integration?"

## The core mechanism: injected-provider wallets are already wallet-agnostic for free

`getMiniPayProvider()` (name is historical, `src/minipayWallet.ts`) is not
actually MiniPay-specific:

```ts
function getMiniPayProvider() {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("No wallet provider found. Open the app in the in-app browser of MiniPay or Trust Wallet.");
  }
  return window.ethereum;
}
```

Any wallet whose in-app browser injects a standard EIP-1193
`window.ethereum` provider works through this exact same path with **zero
code changes** — that's MiniPay, Trust Wallet, and (architecturally, though
verify live before claiming it) MetaMask Mobile. This is the single biggest
fact that made "support more wallets" cheap: it was already generic,
despite the filename suggesting otherwise.

**Verify live before advertising support.** Trust Wallet was confirmed by
an actual end-to-end test (full 3-transaction plan-creation flow completed
in Trust Wallet's in-app browser). MetaMask Mobile was *not* live-tested —
it was deliberately left off the landing page's wallet list and out of the
in-app error message, even though it should theoretically work, because:

1. **No live confirmation** of the actual multi-signature flow
   (`createVault` → `approve` → `setupPlan`, three sequential signing
   round-trips) behaving correctly in that specific WebView.
2. **Celo isn't pre-configured in MetaMask** the way it is in MiniPay/Trust
   Wallet — a user would need to manually add the network (chain ID 42220,
   RPC, explorer) before anything works, and the app doesn't currently call
   `wallet_addEthereumChain`/`wallet_switchEthereumChain` to smooth that
   over. That's a real, specific gap, not just caution for its own sake.

**Rule of thumb:** don't list a wallet as "supported" on marketing surfaces
until it's been actually exercised through the real multi-step flow on a
real device, even if the code path is theoretically identical to a wallet
that *has* been verified.

## The genuinely different case: WalletConnect-only wallets (e.g. Valora)

Wallets without an injected in-app-browser provider need WalletConnect —
architecturally a separate integration, not a config toggle on the existing
path. Analyzed in depth but deliberately **not built**, per explicit
instruction to think it through completely before touching anything that
could put the working MiniPay integration at risk. The framing that made
this a safe analysis rather than a blocker:

- **Isolation is achievable:** a WalletConnect branch can live entirely
  behind a new code path (e.g. a different function than
  `getMiniPayProvider()`), never modifying the existing injected-provider
  flow. The existing integration's safety can be *architecturally*
  guaranteed this way.
- **What can't be guaranteed without live testing:** WalletConnect UX
  quality specifically — deep-link reliability across three *sequential*
  signing round-trips (does the user get bounced back to the wallet app
  correctly each time, or does the connection/session drop between
  `createVault` and `approve`?), session persistence across app
  backgrounding, and — the sharp edge — **partial-failure recovery**: if
  `createVault()` succeeds but `approve()` fails or the user backgrounds the
  app mid-flow, there's now an orphaned vault with no plan set up. The
  injected-provider flow has this same theoretical risk, but WalletConnect's
  extra round-trip latency and app-switching make it measurably more likely
  in practice.

**Decision rule that generalizes:** "architecturally safe to build" and
"safe to ship" are different bars. The first can be reasoned about from the
code. The second — especially for anything involving wallet deep-links,
app-switching, or multi-step on-chain flows — needs a live device test
before commitment, because the failure modes (dropped sessions, orphaned
on-chain state) don't show up by reading the SDK docs.

## Fixing "no wallet found" messaging as wallet support grows

The in-app error message is a single source of truth for "what wallets do
we currently claim to support" — it was originally MiniPay-only text,
updated to "MiniPay or Trust Wallet" the same day Trust Wallet was
confirmed, and deliberately **not** updated to mention MetaMask (per
explicit decision — only list what's verified). Worth keeping this message,
the landing page's wallet list, and any external mini-app-store listing
text in sync as a single checklist whenever wallet support changes, since
they're three separate places that can drift independently.
