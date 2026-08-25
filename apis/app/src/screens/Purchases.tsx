import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection } from 'wagmi';
import { formatUnits } from 'viem';
import { getUserVaults, getUserPurchases, type PurchaseEvent } from '../../../../src/minipayWallet';
import { TARGET_TOKENS } from '../config';
import TokenIcon from '../components/TokenIcon';
import type { AnyTokenSymbol } from '../tokenVisuals';

/// "My Purchases" — neu für Apis, spiegelt 1:1 OSIRIS' eigene, bereits
/// erprobte Ansicht (siehe src/App.tsx View 'purchases'): Kachel-Raster
/// gruppiert nach Zieltoken, mit Drill-down zur Einzel-Historie pro Token.
/// Lädt bei jedem Öffnen frisch (kein eigenes Caching hier — das übernimmt
/// bereits getUserPurchases() selbst via localStorage, siehe minipayWallet.ts).

type TargetTokenSymbol = keyof typeof TARGET_TOKENS;
const TOKENS = Object.keys(TARGET_TOKENS) as TargetTokenSymbol[];

const TARGET_TOKEN_BY_ADDRESS: Record<string, TargetTokenSymbol> = Object.fromEntries(
  TOKENS.map((symbol) => [TARGET_TOKENS[symbol].address.toLowerCase(), symbol]),
) as Record<string, TargetTokenSymbol>;

function formatTokenAmount(raw: bigint, symbol: TargetTokenSymbol): string {
  return Number(formatUnits(raw, TARGET_TOKENS[symbol].decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function formatInputAmount(raw: bigint): string {
  return Number(formatUnits(raw, 6)).toFixed(2); // USDC/USDT — beide 6 Decimals
}

export default function Purchases() {
  const navigate = useNavigate();
  const { address } = useConnection();

  const [purchases, setPurchases] = useState<PurchaseEvent[] | null>(null);
  const [loading, setLoading]     = useState(false);
  const [progress, setProgress]   = useState(0);
  const [error, setError]         = useState<string | null>(null);
  const [selectedToken, setSelectedToken] = useState<TargetTokenSymbol | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    setError(null);
    setProgress(0);
    setLoading(true);
    try {
      const vaultAddresses = await getUserVaults(address);
      const events = await getUserPurchases(vaultAddresses, setProgress);
      setPurchases(events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your purchase history.');
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { void load(); }, [load]);

  const purchasesByToken = useMemo(() => {
    const groups = Object.fromEntries(TOKENS.map((symbol) => [symbol, [] as PurchaseEvent[]])) as Record<TargetTokenSymbol, PurchaseEvent[]>;
    if (!purchases) return groups;
    for (const purchase of purchases) {
      const symbol = TARGET_TOKEN_BY_ADDRESS[purchase.targetToken.toLowerCase()];
      if (symbol) groups[symbol].push(purchase);
    }
    return groups;
  }, [purchases]);

  const purchaseTotals = useMemo(() => {
    const totals = {} as Record<TargetTokenSymbol, { amountOut: bigint; amountIn: bigint; count: number }>;
    for (const symbol of TOKENS) {
      const rows = purchasesByToken[symbol];
      totals[symbol] = {
        amountOut: rows.reduce((sum, row) => sum + row.amountOut, 0n),
        amountIn:  rows.reduce((sum, row) => sum + row.amountIn, 0n),
        count:     rows.length,
      };
    }
    return totals;
  }, [purchasesByToken]);

  const totalInvested = useMemo(
    () => TOKENS.reduce((sum, symbol) => sum + purchaseTotals[symbol].amountIn, 0n),
    [purchaseTotals],
  );

  if (selectedToken) {
    const rows  = purchasesByToken[selectedToken];
    const total = purchaseTotals[selectedToken];
    return (
      <div className="screen screen--sub">
        <div className="app-bar">
          <button type="button" className="app-bar__back" onClick={() => setSelectedToken(null)} aria-label="Back to My Purchases">
            ‹
          </button>
          <span className="app-bar__title">{selectedToken} Purchases</span>
          <span className="app-bar__spacer" />
        </div>

        <div className="section-label">Totals</div>
        <p className="plans-note">
          Total holdings: <strong>{formatTokenAmount(total.amountOut, selectedToken)} {selectedToken}</strong>
          {' '}≈ {formatInputAmount(total.amountIn)} USDC/USDT invested across {total.count} purchase{total.count === 1 ? '' : 's'}
        </p>

        {rows.length === 0 && <p className="plans-note">No purchases yet.</p>}

        <div className="plan-list">
          {rows.map((row) => (
            <div key={row.txHash + row.step} className="plan-card">
              <div className="plan-card__top">
                <span style={{ fontSize: 14, fontWeight: 700 }}>
                  Step {row.step}: +{formatTokenAmount(row.amountOut, selectedToken)} {selectedToken}
                </span>
              </div>
              <p className="sell-sub">
                {formatInputAmount(row.amountIn)} {row.inputTokenSymbol} · {row.timestamp ? new Date(row.timestamp * 1000).toLocaleString() : 'pending'}
              </p>
              <a className="plan-card__address" href={`https://celoscan.io/tx/${row.txHash}`} rel="noreferrer">
                View on Celoscan ↗
              </a>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/plans')} aria-label="Back to My Plans">
          ‹
        </button>
        <span className="app-bar__title">My Purchases</span>
        <span className="app-bar__spacer" />
      </div>

      {loading && (
        <div className="progress-block">
          <div className="progress-label">
            <span className="plans-note">Loading your purchase history…</span>
            <b>{Math.round(progress * 100)}%</b>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>
      )}
      {error && <p className="createcode-error">{error}</p>}

      {!loading && !error && purchases && (
        <>
          <p className="plans-note">Total invested: <strong>{formatInputAmount(totalInvested)} USDC/USDT</strong></p>

          <div className="tile-grid" style={{ margin: '0 18px' }}>
            {TOKENS.map((symbol) => (
              <button
                key={symbol}
                type="button"
                className="tile"
                onClick={() => setSelectedToken(symbol)}
              >
                <span className="tile-symbol"><TokenIcon token={symbol as AnyTokenSymbol} size={16} /> {symbol}</span>
                <span className="tile-amount">{formatTokenAmount(purchaseTotals[symbol].amountOut, symbol)}</span>
                <span className="tile-balance">
                  {purchaseTotals[symbol].count} purchase{purchaseTotals[symbol].count === 1 ? '' : 's'}
                </span>
              </button>
            ))}
          </div>

          {purchases.length === 0 && <p className="plans-note">No purchases yet.</p>}
        </>
      )}
    </div>
  );
}
