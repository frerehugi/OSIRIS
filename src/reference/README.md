# `src/reference/`

Dormant reference ports: implementations lifted from external repos the user asked
Claude to study, adapted to this project's config/types, but **not wired into any
live screen**. Nothing here is imported by `App.tsx`, `apis/app`, or the keeper.

Each file documents in its own header:
- where the pattern came from (repo + specific file/function),
- what it does and doesn't carry over from the original,
- what a session needs to do to actually activate it (new dependency, which
  screen to wire it into, etc).

This exists so a cold session — Claude or human — can find "didn't we already look
at X for this?" instead of re-researching or re-implementing it. See
`CELO_README.md` (§ "External reference ports") for the index of what's here and why.

## Current contents

| File | Ported from | Purpose | Status |
|---|---|---|---|
| `paymentRequestQr.ts` | [`Investorquab/CeloDesk`](https://github.com/Investorquab/CeloDesk), `frontend/components/CheckoutClient.tsx` (`paymentQrValue()`) | Builds an EIP-681 payment-request URI (`ethereum:<token>@<chainId>/transfer?...`) for a scannable QR that MiniPay/any EIP-681-aware wallet reads to prefill a token transfer. | Dormant — logic only, no QR-rendering dependency added yet. |
