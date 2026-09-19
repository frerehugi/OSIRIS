// get_token_prices / GET /token-prices — reine Marktdaten, kein Grant nötig
// (anders als get_balances/get_plans, die grant-owner-spezifisch sind).
// Fragt Squids /v2/token-price direkt ab, dieselbe Quelle, die der Keeper für
// Trigger-Pläne prüft (keeper/squidKeeper.ts, getTokenPriceUsd()) und die
// src/squidPrice.ts fürs OSIRIS/APIS-Frontend nutzt — eine einzige Quelle
// der Wahrheit für "was ist der aktuelle Preis", nicht drei verschiedene
// Implementationen. Ohne dieses Tool hatte eine verbundene KI keinen Weg,
// eine "Squidrouter-Preis"-Frage tatsächlich mit Squids eigenem Kurs zu
// beantworten und wich auf eigenes Wissen/Websuche (z.B. CoinGecko) aus —
// siehe capabilities.ts' priceSources-Kommentar: das ist genau die Quelle,
// die vom echten System (Keeper) tatsächlich verwendet wird, und die beiden
// können laut SECURITY.md real voneinander abweichen.

import { ACTIVE_CHAIN_ID, SQUID_INTEGRATOR_ID, TARGET_TOKENS } from '../../../src/config';

const PRICE_TOKENS = [
  TARGET_TOKENS.CELO,
  TARGET_TOKENS.XAUoT,
  TARGET_TOKENS.wBTC,
  TARGET_TOKENS.wETH,
] as const;

interface TokenPriceResult {
  symbol:   string;
  usdPrice: number | null;
  error?:   string;
}

// Real, beobachtet über ein externes AskBots-Review: 6 von 10 gleichzeitigen
// Reviewern bekamen usdPrice:null für ALLE vier Token, während ein anderer im
// selben Zeitfenster echte Preise für alle vier bekam — das schließt eine
// grundsätzlich kaputte Integration aus (die Werte kommen nachweislich durch)
// und zeigt stattdessen Flakiness, am ehesten Rate-Limiting durch viele
// gleichzeitige Requests auf dieselbe SQUID_INTEGRATOR_ID. Der alte Code
// schluckte JEDEN Fehler (Timeout, 429, kaputtes JSON, ...) beim ersten
// Versuch still zur immergleichen generischen Meldung, ohne Retry und ohne
// den echten Grund irgendwo sichtbar zu machen. Fix: ein kurzer Retry pro
// Token, und der tatsächliche letzte Fehler wird geloggt (sichtbar über
// `wrangler tail`), bevor wir wirklich aufgeben — die an den Aufrufer
// zurückgegebene Meldung bleibt bewusst generisch (kein Leak von internen
// Fehlerdetails an eine verbundene KI/den Nutzer).
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTokenPrice(token: { symbol: string; address: string }): Promise<TokenPriceResult> {
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const url = new URL('https://apiplus.squidrouter.com/v2/token-price');
      url.searchParams.set('chainId', ACTIVE_CHAIN_ID);
      url.searchParams.set('tokenAddress', token.address);

      const response = await fetch(url.toString(), {
        headers: { 'x-integrator-id': SQUID_INTEGRATOR_ID },
      });
      if (!response.ok) throw new Error(`Squid token-price failed: HTTP ${response.status}`);

      const data = await response.json() as { token?: { usdPrice?: number } };
      const usdPrice = data.token?.usdPrice;
      if (typeof usdPrice !== 'number' || !Number.isFinite(usdPrice)) {
        throw new Error('no valid usdPrice in response');
      }
      return { symbol: token.symbol, usdPrice };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }

  console.error(`get_token_prices: ${token.symbol} failed after ${MAX_ATTEMPTS} attempt(s) — ${lastError}`);
  return { symbol: token.symbol, usdPrice: null, error: 'Could not read this price right now.' };
}

export async function getSquidTokenPrices(): Promise<{
  source: string; chainId: string; prices: TokenPriceResult[];
}> {
  const prices = await Promise.all(PRICE_TOKENS.map(fetchTokenPrice));
  return { source: 'squid-token-price', chainId: ACTIVE_CHAIN_ID, prices };
}
