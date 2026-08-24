import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useConnection, useReadContracts } from 'wagmi';
import { formatUnits } from 'viem';
import { ERC20_ABI, TARGET_TOKENS } from '../config';
import TokenIcon from '../components/TokenIcon';
import type { TargetSymbol } from '../triggerPlanTypes';

const COINS = Object.keys(TARGET_TOKENS) as TargetSymbol[];

function formatBalance(raw: bigint, decimals: number): string {
  return Number(formatUnits(raw, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function isTargetSymbol(value: string | null): value is TargetSymbol {
  return !!value && (COINS as string[]).includes(value);
}

/// Schritt 1 des Sell-Plan-Flows — zeigt die tatsächlichen Bestände (wie
/// Holdings.tsx), genau ein Coin wählbar (siehe Chat). Optional per
/// ?token=... vorbelegt (Deep-Link von My Holdings' "Sell"-Button).
export default function SellPlanCoinSelect() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { address } = useConnection();
  const preselected = searchParams.get('token');
  const [selected, setSelected] = useState<TargetSymbol | null>(isTargetSymbol(preselected) ? preselected : null);

  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: address
      ? COINS.map((symbol) => ({
          address: TARGET_TOKENS[symbol].address, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [address] as const,
        }))
      : [],
  });

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/trigger-setup')} aria-label="Back">
          ‹
        </button>
        <span className="app-bar__title">New Sell Plan</span>
        <span className="app-bar__spacer" />
      </div>

      <p className="createcode-sub">Which holding do you want to sell?</p>

      <div className="holdings-list">
        {COINS.map((symbol, i) => {
          const result = data?.[i];
          const raw = result?.status === 'success' ? (result.result as bigint) : null;
          return (
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
              <span className="holding-row__amount">
                {isLoading ? '···' : raw !== null ? formatBalance(raw, TARGET_TOKENS[symbol].decimals) : '—'}
              </span>
              {selected === symbol && <span className="coin-row__check">✓</span>}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="btn-gold"
        disabled={!selected}
        onClick={() => navigate('/trigger-setup/sell/details', { state: { cryptoSymbol: selected } })}
      >
        Next
      </button>
    </div>
  );
}
