import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TARGET_TOKENS } from '../config';
import TokenIcon from '../components/TokenIcon';
import type { TargetSymbol } from '../triggerPlanTypes';

const COINS = Object.keys(TARGET_TOKENS) as TargetSymbol[];

/// Schritt 1 des Buy-Plan-Flows — genau ein Coin wählbar (siehe Chat).
export default function BuyPlanCoinSelect() {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<TargetSymbol | null>(null);

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/trigger-setup')} aria-label="Back">
          ‹
        </button>
        <span className="app-bar__title">New Buy Plan</span>
        <span className="app-bar__spacer" />
      </div>

      <p className="createcode-sub">Which coin do you want to buy?</p>

      <div className="holdings-list">
        {COINS.map((symbol) => (
          <button
            key={symbol}
            type="button"
            className={`coin-row${selected === symbol ? ' coin-row--selected' : ''}`}
            onClick={() => setSelected(symbol)}
          >
            <TokenIcon token={symbol} size={30} />
            <span className="holding-row__name">
              <span className="holding-row__symbol">{symbol}</span>
            </span>
            {selected === symbol && <span className="coin-row__check">✓</span>}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="btn-gold"
        disabled={!selected}
        onClick={() => navigate('/trigger-setup/buy/details', { state: { cryptoSymbol: selected } })}
      >
        Next
      </button>
    </div>
  );
}
