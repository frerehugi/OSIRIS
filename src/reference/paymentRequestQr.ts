// ─── Reference port: EIP-681 payment-request QR (from CeloDesk) ───────────────
//
// Ported from the public repo Investorquab/CeloDesk
// (https://github.com/Investorquab/CeloDesk), frontend/components/
// CheckoutClient.tsx, function paymentQrValue() — reviewed at the user's
// request on 21.09.2026. See src/reference/README.md and CELO_README.md
// ("External reference ports") for why this folder exists.
//
// DORMANT — and, as of 21.09.2026, with NO IDENTIFIED USE CASE in this repo,
// Sterntaler, or Clock-it. Corrected after an initial (wrong) claim that this
// could power a "scan to fund your vault" flow: it can't. DcaVault.sol's
// setupPlan() (and SendVault/TriggerVault's equivalents) pull the input
// token via `inputToken.safeTransferFrom(owner, address(this), _totalAmount)`
// — the vault is funded by the owner's own approve()+setupPlan() call in a
// single connected-wallet session, not by anyone (owner or otherwise)
// sending tokens to the vault address afterwards. There is no `topUp()`;
// funds sent to a vault address outside setupPlan() would sit there
// unaccounted by the plan. Sterntaler's README describes the identical
// 3-tx createVault()→approve()→setupPlan() pattern, so the same reasoning
// rules it out there. Clock-it never moves tokens at all (see its own
// src/lib/qr.ts — a location-identifier QR, not a payment one).
//
// Kept here anyway (code is correct EIP-681 in isolation) in case a future
// feature actually needs "hand someone a QR so they can send tokens to an
// address without opening the app" — none of OSIRIS/APIS/Sterntaler/Clock-it
// have that moment today: money movement is always either pulled in one
// wallet session (approve+setupPlan) or pushed automatically by a keeper.
// If you're reading this considering activation, first confirm the feature
// you're building actually has that moment — it's the one precondition for
// this module being useful at all. If so:
//   1. `npm install qrcode.react` (CeloDesk's own choice; any EIP-681-capable
//      QR renderer works).
//   2. Render `<QRCodeSVG value={buildEip681PaymentUri(...)} />` wherever
//      that screen is.
//
// What carried over: the URI format itself — EIP-681's
// `ethereum:<tokenAddress>@<chainId>/transfer?address=<to>&uint256=<atomic>`
// — plus the decimal-to-atomic conversion, both copied faithfully since
// they're just spec compliance, not CeloDesk-specific business logic.
//
// What did NOT carry over, on purpose: CeloDesk's
// `wallet_switchEthereumChain`/`wallet_addEthereumChain` chain-switch dance
// (its CheckoutClient.tsx `pay()`). This repo's own src/minipayWallet.ts
// already documents (see its "MiniPay-Deeplinks" section) that MiniPay does
// not support programmatic chain switching and is Celo-only by construction
// — that logic would only ever matter for a hypothetical non-MiniPay EVM
// wallet path, and porting it here unused would just be dead code.

import type { TokenInfo } from "../config";

/**
 * Converts a human decimal amount ("12.5") to its atomic integer form for a
 * token with the given decimals, without floating-point rounding.
 */
export function decimalToAtomic(value: string | number, decimals: number): bigint {
  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`decimalToAtomic: invalid decimal amount "${value}"`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export interface Eip681PaymentRequestParams {
  /** The token being requested — only `address`/`decimals` are used. */
  token: Pick<TokenInfo, "address" | "decimals">;
  /** Numeric chain ID, e.g. config.ts's CELO_CHAIN_ID ("42220"). */
  chainId: string | number;
  /** Receiving wallet address. */
  to: `0x${string}`;
  /** Human decimal amount, e.g. "5.00". */
  amount: string | number;
}

/**
 * Builds an EIP-681 "transfer" payment-request URI: scanning it in a
 * compatible wallet (MiniPay included) prefills a token transfer of `amount`
 * of `token` to `to`, on `chainId`. This is a payment *request*, not a
 * redirect to a website — the wallet never leaves its own send flow.
 */
export function buildEip681PaymentUri(params: Eip681PaymentRequestParams): string {
  const atomic = decimalToAtomic(params.amount, params.token.decimals);
  return `ethereum:${params.token.address}@${params.chainId}/transfer?address=${params.to}&uint256=${atomic.toString()}`;
}
