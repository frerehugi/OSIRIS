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

export async function getSquidTokenPrices(): Promise<{
  source: string; chainId: string; prices: TokenPriceResult[];
}> {
  const prices = await Promise.all(
    PRICE_TOKENS.map(async (token): Promise<TokenPriceResult> => {
      try {
        const url = new URL('https://apiplus.squidrouter.com/v2/token-price');
        url.searchParams.set('chainId', ACTIVE_CHAIN_ID);
        url.searchParams.set('tokenAddress', token.address);

        const response = await fetch(url.toString(), {
          headers: { 'x-integrator-id': SQUID_INTEGRATOR_ID },
        });
        if (!response.ok) throw new Error(`Squid token-price failed: ${response.status}`);

        const data = await response.json() as { token?: { usdPrice?: number } };
        const usdPrice = data.token?.usdPrice;
        if (typeof usdPrice !== 'number' || !Number.isFinite(usdPrice)) {
          throw new Error('no valid usdPrice in response');
        }
        return { symbol: token.symbol, usdPrice };
      } catch {
        return { symbol: token.symbol, usdPrice: null, error: 'Could not read this price right now.' };
      }
    }),
  );

  return { source: 'squid-token-price', chainId: ACTIVE_CHAIN_ID, prices };
}
