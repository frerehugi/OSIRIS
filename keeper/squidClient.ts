// Squid /v2/route-Client — keine Wallet-Abhängigkeit, damit sowohl der
// Keeper (broadcastet) als auch reine Debug-/Read-Scripts (simulieren nur)
// diesen Code nutzen können, ohne KEEPER_PRIVATE_KEY zu benötigen.

import axios from "axios";
import { ACTIVE_CHAIN_ID } from "../src/config";

export interface SquidTransactionRequest {
  target: `0x${string}`;
  data:   `0x${string}`;
}

export interface SquidEstimate {
  toAmountMin: string;
}

export interface SquidRoute {
  transactionRequest: SquidTransactionRequest;
  estimate:            SquidEstimate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mindestabstand zwischen zwei Squid-Requests. Retry-with-Backoff unten fängt
// zusätzlich einzelne 429/502/504 ab, falls dieser Abstand allein nicht reicht.
export const SQUID_REQUEST_SPACING_MS = 2_000;

// Feste Backoff-Staffel für 429 (Rate-Limit) und 502 (Bad Gateway) — 3 Retries,
// danach wird der letzte Fehler durchgereicht.
const RETRY_BACKOFFS_MS = [5_000, 15_000, 45_000];

// Squids eigene Slippage-Toleranz für die Route selbst (nicht zu verwechseln
// mit dem SLIPPAGE_BPS_BUFFER des Keepers): Squid baut diesen Wert in die
// zurückgegebene Calldata ein und lässt die Route intern revertieren, wenn
// sich der Preis zwischen Quote und On-Chain-Ausführung stärker bewegt. Ein
// Revert hier zeigt sich am Vault als SwapFailed() (router.call schlägt
// fehl), nicht als SlippageExceeded() — der Keeper-Puffer greift also nicht,
// wenn dieser Wert zu knapp ist. War bei 1.5% zu eng (beobachtete
// SwapFailed()-Reverts).
export const SQUID_QUOTE_SLIPPAGE_PERCENT = 5;

// Squids "retry-after" bei 504 (Gateway Timeout) lag beobachtet bei ~120s —
// deutlich länger als der Rate-Limit-Backoff für 429. Fallback, falls der
// Header fehlt oder nicht parsbar ist.
const SQUID_GATEWAY_TIMEOUT_FALLBACK_MS = 120_000;

// ─── Squid-Integrator-ID ──────────────────────────────────────────────────────
//
// Kommt bewusst aus keeper/.env (nicht aus src/config.ts) — der Keeper ist ein
// eigenständiger Prozess mit eigenen Secrets. Solange die echte ID bei Squid
// noch nicht beantragt/vergeben ist, steht hier der Platzhalter "PENDING";
// Aufrufer verweigern in dem Fall den Start mit einer klaren Fehlermeldung,
// statt Requests zu senden, die Squid im Zweifel ablehnt oder ratelimited.

export function getValidatedIntegratorId(): string {
  const id = process.env.SQUID_INTEGRATOR_ID;
  if (!id) {
    throw new Error("SQUID_INTEGRATOR_ID Umgebungsvariable fehlt (keeper/.env).");
  }
  if (id === "PENDING") {
    throw new Error(
      "SQUID_INTEGRATOR_ID ist noch der Platzhalter 'PENDING'. " +
      "Echte Integrator-ID bei Squid (https://app.squidrouter.com/) beantragen " +
      "und in keeper/.env eintragen, bevor Squid-Requests gesendet werden."
    );
  }
  return id;
}

export async function getSquidRoute(params: {
  fromToken:   `0x${string}`;
  toToken:     `0x${string}`;
  fromAmount:  string;
  fromAddress: `0x${string}`;
  toAddress:   `0x${string}`;
}): Promise<SquidRoute> {
  const integratorId = getValidatedIntegratorId();

  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
    try {
      const response = await axios.post(
        "https://apiplus.squidrouter.com/v2/route",
        {
          fromChain:   ACTIVE_CHAIN_ID,
          toChain:     ACTIVE_CHAIN_ID, // Same-Chain-Swap innerhalb Celo
          fromToken:   params.fromToken,
          toToken:     params.toToken,
          fromAmount:  params.fromAmount,
          fromAddress: params.fromAddress, // = Vault: er ist msg.sender beim Router-Call
          toAddress:   params.toAddress,   // = Owner: dorthin soll der Output fließen
          slippage:    SQUID_QUOTE_SLIPPAGE_PERCENT, // Contract erzwingt minAmountOut zusätzlich on-chain
          quoteOnly:   false,              // echte, ausführbare Route inkl. Calldata
        },
        {
          headers: {
            "x-integrator-id": integratorId,
            "Content-Type":    "application/json",
          },
        }
      );
      return response.data.route as SquidRoute;
    } catch (err) {
      if (!axios.isAxiosError(err)) throw err;

      const status = err.response?.status;
      const isRetryable = status === 429 || status === 502 || status === 504;
      if (!isRetryable || attempt === RETRY_BACKOFFS_MS.length) throw err;

      let backoffMs = RETRY_BACKOFFS_MS[attempt];
      if (status === 504) {
        // Squid sendet bei 504 einen eigenen retry-after-Header (Sekunden) —
        // dem vertrauen wir hier (beobachtet: ~120s, länger als die feste
        // Staffel), anders als bei 429/502 oben, wo er sich in der Praxis
        // als zu knapp erwiesen hat.
        const retryAfterSeconds = Number(err.response?.headers?.["retry-after"]);
        backoffMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1_000
          : SQUID_GATEWAY_TIMEOUT_FALLBACK_MS;
      }

      console.warn(
        `Squid: ${status} für ${params.toToken} — warte ${backoffMs}ms ` +
        `(Versuch ${attempt + 1}/${RETRY_BACKOFFS_MS.length})`
      );
      await sleep(backoffMs);
    }
  }
  throw new Error("Squid-Route: unerreichbar nach maximalen Versuchen.");
}
