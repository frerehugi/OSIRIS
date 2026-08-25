import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useConnection, useReadContracts } from 'wagmi';
import { formatUnits } from 'viem';
import { ERC20_ABI, TARGET_TOKENS } from '../config';
import TokenIcon from '../components/TokenIcon';
import { TOKEN_COLOR } from '../tokenVisuals';
import type { TargetSymbol, StableSymbol, TimeLimit, TriggerPlanDraft } from '../triggerPlanTypes';
import { TIME_LIMIT_LABEL } from '../triggerPlanTypes';

const TIME_LIMITS: TimeLimit[] = ['1d', '1w', '1m', 'none'];

function formatBalance(raw: bigint, decimals: number): string {
  return Number(formatUnits(raw, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/// Strikt statt `.replace(/,/g, '')`: siehe BuyPlanDetails.tsx — ein
/// Dezimalkomma ("0,08") würde sonst lautlos zu einem Faktor-100-Fehler
/// im On-Chain-Trigger-Preis. Lieber ablehnen als falsch interpretieren.
function parsePositiveDecimal(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed > 0 ? parsed : null;
}

/// Schritt 2 des Sell-Plan-Flows — Betrag per Schieberegler (Anteil des
/// Bestands), Preis, Laufzeit (siehe Chat). "Sell" löst als Take-Profit aus
/// (Preis steigt AUF/ÜBER den eingegebenen Wert) — Gegenstück zu
/// BuyPlanDetails' Dip-Kauf-Logik.
export default function SellPlanDetails() {
  const navigate = useNavigate();
  const location = useLocation();
  const { address } = useConnection();
  const cryptoSymbol = (location.state as { cryptoSymbol?: TargetSymbol } | null)?.cryptoSymbol;

  const [stableSymbol, setStableSymbol] = useState<StableSymbol>('USDT');
  const [percent, setPercent] = useState(50);
  const [priceInput, setPriceInput] = useState('');
  const [timeLimit, setTimeLimit] = useState<TimeLimit>('none');
  const [error, setError] = useState<string | null>(null);

  const token = cryptoSymbol ? TARGET_TOKENS[cryptoSymbol] : null;

  const { data: balanceResults } = useReadContracts({
    allowFailure: true,
    contracts: address && token
      ? [{ address: token.address, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [address] as const }]
      : [],
  });
  const balanceResult = balanceResults?.[0];
  const balanceRaw = balanceResult?.status === 'success' ? (balanceResult.result as bigint) : null;

  if (!cryptoSymbol || !token) {
    navigate('/trigger-setup/sell', { replace: true });
    return null;
  }

  const sellAmountRaw = balanceRaw !== null ? (balanceRaw * BigInt(percent)) / 100n : null;
  const sellAmountHuman = sellAmountRaw !== null ? formatUnits(sellAmountRaw, token.decimals) : '0';

  const handleOk = () => {
    const priceNum = parsePositiveDecimal(priceInput);
    if (priceNum === null) { setError('Enter a valid sell price — use a period for decimals, e.g. 75000.50.'); return; }
    if (!balanceRaw || balanceRaw === 0n) { setError(`You have no ${cryptoSymbol} to sell.`); return; }
    if (!sellAmountRaw || sellAmountRaw === 0n) { setError('Amount is too small.'); return; }

    const draft: TriggerPlanDraft = {
      direction: 'sell', cryptoSymbol, stableSymbol, priceUsd: priceNum, amountHuman: sellAmountHuman, timeLimit,
    };
    navigate('/trigger-setup/review', { state: draft });
  };

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate(-1)} aria-label="Back">
          ‹
        </button>
        <span className="app-bar__title">New Sell Plan</span>
        <span className="app-bar__spacer" />
      </div>

      <p className="sell-sub" style={{ padding: '8px 18px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
        <TokenIcon token={cryptoSymbol} size={16} /> Selling {cryptoSymbol}
      </p>

      <div className="section-label">Amount to sell</div>
      <div className="sell-card">
        <div className="sell-amount">
          <div className="sell-amount__value">{percent}%</div>
          <div className="sell-amount__of">
            {balanceRaw !== null ? `${sellAmountHuman} of ${formatBalance(balanceRaw, token.decimals)} ${cryptoSymbol}` : `of your ${cryptoSymbol}`}
          </div>
        </div>
        <input
          className={`sell-slider slider-thumb-${cryptoSymbol}`}
          type="range"
          min={1}
          max={100}
          value={percent}
          onChange={(e) => setPercent(Number(e.target.value))}
          style={{
            background: `linear-gradient(to right, ${TOKEN_COLOR[cryptoSymbol]} 0%, ${TOKEN_COLOR[cryptoSymbol]} ${percent}%, rgba(255,255,255,0.12) ${percent}%, rgba(255,255,255,0.12) 100%)`,
          }}
        />
      </div>

      <div className="section-label">Sell price — sell at or above</div>
      <div className="sell-card">
        <div className="sell-price-row">
          <span>$</span>
          <input type="text" inputMode="decimal" placeholder="0.00" value={priceInput} onChange={(e) => setPriceInput(e.target.value)} />
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
