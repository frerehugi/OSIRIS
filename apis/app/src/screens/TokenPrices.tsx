import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TARGET_TOKENS, fetchTokenPriceUsd } from '../config';
import TokenIcon from '../components/TokenIcon';
import type { AnyTokenSymbol } from '../tokenVisuals';

/// Live Squid /token-price-Anzeige — gleiche Quelle, die der Keeper für
/// Preis-Trigger-Pläne prüft (siehe keeper/squidKeeper.ts), hier nur zur
/// Anzeige. Kein Wallet-Call nötig (anders als Holdings.tsx), daher auch
/// kein useReadContracts — reiner fetch() gegen die Squid-API.

interface PriceToken {
  symbol:  AnyTokenSymbol;
  address: `0x${string}`;
  label:   string;
}

const PRICE_TOKENS: PriceToken[] = [
  { symbol: 'XAUoT', address: TARGET_TOKENS.XAUoT.address, label: 'Tether Gold' },
  { symbol: 'wBTC',  address: TARGET_TOKENS.wBTC.address,  label: 'Wrapped Bitcoin' },
  { symbol: 'wETH',  address: TARGET_TOKENS.wETH.address,  label: 'Wrapped Ether' },
  { symbol: 'CELO',  address: TARGET_TOKENS.CELO.address,  label: 'Celo' },
];

function formatPrice(price: number): string {
  return `$${price.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}

export default function TokenPrices() {
  const navigate = useNavigate();
  // null = Lookup für dieses Token fehlgeschlagen, undefined = noch nicht geladen.
  const [prices, setPrices]   = useState<Partial<Record<AnyTokenSymbol, number | null>>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // Jedes Token unabhängig laden — ein fehlschlagender Squid-Lookup soll
    // nicht den ganzen Screen leer lassen, gleiches Isolationsmuster wie im
    // Keeper (siehe keeper/squidKeeper.ts, findExecutableTriggerVaults()).
    (async () => {
      const entries = await Promise.all(
        PRICE_TOKENS.map(async ({ symbol, address }) => {
          try {
            return [symbol, await fetchTokenPriceUsd(address)] as const;
          } catch (error) {
            console.error(`Loading Squid price for ${symbol} failed`, error);
            return [symbol, null] as const;
          }
        }),
      );
      if (!cancelled) {
        setPrices(Object.fromEntries(entries));
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/home')} aria-label="Back to Home">
          ‹
        </button>
        <span className="app-bar__title">Squidrouter Token Prices</span>
        <span className="app-bar__spacer" />
      </div>

      <div className="holdings-list">
        {PRICE_TOKENS.map(({ symbol, label }) => {
          const price = prices[symbol];
          return (
            <div key={symbol} className="holding-row">
              <TokenIcon token={symbol} size={30} />
              <div className="holding-row__name">
                <span className="holding-row__symbol">{symbol === 'XAUoT' ? 'Gold' : symbol}</span>
                <span className="holding-row__full">{label}</span>
              </div>
              <div className="holding-row__amount">
                {loading && price === undefined
                  ? '···'
                  : price === null
                    ? '—'
                    : price !== undefined
                      ? formatPrice(price)
                      : '—'}
              </div>
            </div>
          );
        })}
      </div>

      <p className="holdings-note">
        Live quote prices from the Squid Router API — the same source the keeper checks for
        price-trigger plans. Can briefly differ from other price charts (e.g. CoinGecko).
      </p>
    </div>
  );
}
