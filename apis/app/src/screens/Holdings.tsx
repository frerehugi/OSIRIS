import { useNavigate } from 'react-router-dom';
import { useConnection, useReadContracts } from 'wagmi';
import { formatUnits } from 'viem';
import { ERC20_ABI, INPUT_TOKENS, TARGET_TOKENS, type TokenInfo } from '../config';
import TokenIcon from '../components/TokenIcon';
import type { AnyTokenSymbol } from '../tokenVisuals';

/// Reine Lese-Funktion, kein neuer Contract nötig (siehe Gesamtplan §23,
/// Schritt "My Holdings"). Zeigt die sechs von OSIRIS/Squid unterstützten
/// Token — bewusst inkl. CELO (siehe Gesamtplan §6: die "kein CELO
/// anzeigen"-Regel der MiniPay-Referenz betrifft die Fee-Currency-Auswahl,
/// nicht eine Portfolio-Ansicht wie diese).
///
/// Noch NICHT Teil dieses Screens: Fiat-Gegenwert (bräuchte die Provider-
/// Registry/Preisquellen aus Gesamtplan §16 — eigener, späterer Schritt).

interface HoldingRow extends TokenInfo {
  fullName: string;
  sellable: boolean; // nur TARGET_TOKENS sind gültige sellToken für ConditionalSellOrder
}

const HOLDINGS: HoldingRow[] = [
  { ...INPUT_TOKENS.USDC,   fullName: 'USD Coin',        sellable: false },
  { ...INPUT_TOKENS.USDT,   fullName: 'Tether USD',      sellable: false },
  { ...TARGET_TOKENS.CELO,  fullName: 'Celo',            sellable: true },
  { ...TARGET_TOKENS.XAUoT, fullName: 'Tether Gold',     sellable: true },
  { ...TARGET_TOKENS.wBTC,  fullName: 'Wrapped Bitcoin', sellable: true },
  { ...TARGET_TOKENS.wETH,  fullName: 'Wrapped Ether',   sellable: true },
];

function formatAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatBalance(raw: bigint, decimals: number): string {
  return Number(formatUnits(raw, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export default function Holdings() {
  const navigate = useNavigate();
  const { address } = useConnection();

  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: address
      ? HOLDINGS.map((token) => ({
          address:      token.address,
          abi:          ERC20_ABI,
          functionName: 'balanceOf' as const,
          args:         [address] as const,
        }))
      : [],
  });

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/home')} aria-label="Back to Home">
          ‹
        </button>
        <span className="app-bar__title">My Holdings</span>
        <span className="app-bar__spacer" />
      </div>

      {address && <p className="holdings-address">{formatAddress(address)}</p>}

      <div className="holdings-list">
        {HOLDINGS.map((token, i) => {
          const result = data?.[i];
          const raw = result?.status === 'success' ? (result.result as bigint) : null;
          return (
            <div key={token.symbol} className="holding-row">
              <TokenIcon token={token.symbol as AnyTokenSymbol} size={30} />
              <div className="holding-row__name">
                <span className="holding-row__symbol">{token.symbol}</span>
                <span className="holding-row__full">{token.fullName}</span>
              </div>
              <div className="holding-row__amount">
                {isLoading ? '···' : raw !== null ? formatBalance(raw, token.decimals) : '—'}
              </div>
              {token.sellable && (
                <button
                  type="button"
                  className="holding-row__sell"
                  onClick={() => navigate(`/trigger-setup/sell?token=${token.symbol}`)}
                  aria-label={`Set a sell trigger for ${token.symbol}`}
                >
                  Sell
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="holdings-note">
        Balances read directly from your MiniPay wallet. Apis never holds custody — this is a view, not a transfer.
      </p>
    </div>
  );
}
