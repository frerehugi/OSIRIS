import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import TokenIcon from '../components/TokenIcon';
import type { TargetSymbol, StableSymbol, TimeLimit, TriggerPlanDraft } from '../triggerPlanTypes';
import { TIME_LIMIT_LABEL } from '../triggerPlanTypes';

const TIME_LIMITS: TimeLimit[] = ['1d', '1w', '1m', 'none'];

/// Schritt 2 des Buy-Plan-Flows — Preis, Betrag, Laufzeit (siehe Chat).
/// "Buy" löst hier bewusst als Dip-Kauf aus (Preis fällt AUF/UNTER den
/// eingegebenen Wert) — das gängige Verständnis eines manuellen Kauf-
/// Triggers (Limit-Buy). Steht auch so in der UI-Kopie, damit es nicht
/// stillschweigend angenommen wird.
export default function BuyPlanDetails() {
  const navigate = useNavigate();
  const location = useLocation();
  const cryptoSymbol = (location.state as { cryptoSymbol?: TargetSymbol } | null)?.cryptoSymbol;

  const [stableSymbol, setStableSymbol] = useState<StableSymbol>('USDC');
  const [priceInput, setPriceInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [timeLimit, setTimeLimit] = useState<TimeLimit>('none');
  const [error, setError] = useState<string | null>(null);

  if (!cryptoSymbol) {
    navigate('/trigger-setup/buy', { replace: true });
    return null;
  }

  const handleOk = () => {
    const priceNum = Number(priceInput.replace(/,/g, ''));
    const amountNum = Number(amountInput.replace(/,/g, ''));
    if (!(priceNum > 0)) { setError('Enter a valid trigger price.'); return; }
    if (!(amountNum > 0)) { setError('Enter a valid amount.'); return; }

    const draft: TriggerPlanDraft = {
      direction: 'buy', cryptoSymbol, stableSymbol, priceUsd: priceNum, amountHuman: amountInput, timeLimit,
    };
    navigate('/trigger-setup/review', { state: draft });
  };

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate(-1)} aria-label="Back">
          ‹
        </button>
        <span className="app-bar__title">New Buy Plan</span>
        <span className="app-bar__spacer" />
      </div>

      <p className="sell-sub" style={{ padding: '8px 18px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
        <TokenIcon token={cryptoSymbol} size={16} /> Buying {cryptoSymbol}
      </p>

      <div className="section-label">Trigger price — buy at or below</div>
      <div className="sell-card">
        <div className="sell-price-row">
          <span>$</span>
          <input type="text" inputMode="decimal" placeholder="0.00" value={priceInput} onChange={(e) => setPriceInput(e.target.value)} />
          <span>USD</span>
        </div>
      </div>

      <div className="section-label">Amount to spend</div>
      <div className="sell-card">
        <div className="sell-price-row">
          <input type="text" inputMode="decimal" placeholder="0.00" value={amountInput} onChange={(e) => setAmountInput(e.target.value)} />
          <span>{stableSymbol}</span>
        </div>
        <div className="segmented" style={{ margin: 0 }}>
          <button type="button" className={stableSymbol === 'USDC' ? 'active' : undefined} onClick={() => setStableSymbol('USDC')}>USDC</button>
          <button type="button" className={stableSymbol === 'USDT' ? 'active' : undefined} onClick={() => setStableSymbol('USDT')}>USDT</button>
        </div>
      </div>

      <div className="section-label">Set up time limit?</div>
      <div className="segmented segmented--4">
        {TIME_LIMITS.map((limit) => (
          <button key={limit} type="button" className={timeLimit === limit ? 'active' : undefined} onClick={() => setTimeLimit(limit)}>
            {TIME_LIMIT_LABEL[limit]}
          </button>
        ))}
      </div>
      <p className="sell-sub">Your plan can be cancelled any time, whether or not it has a time limit.</p>

      {error && <p className="createcode-error">{error}</p>}

      <button type="button" className="btn-gold" onClick={handleOk}>OK</button>
    </div>
  );
}
