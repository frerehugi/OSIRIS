import { formatUnits } from 'viem';
import { TRIGGER_STATUS_LABEL, formatExpiry, triggerPillClass, type TriggerPlanSummary } from '../hooks/usePlans';
import type { AnyTokenSymbol } from '../tokenVisuals';
import TokenIcon from './TokenIcon';

/// Kartendarstellung für einen einzelnen Trigger-Plan (Buy/Sell) — identisch
/// zur bisherigen Inline-Darstellung in Plans.tsx, jetzt als eigene
/// Komponente für die drei Status-Unterordner. Der Cancel-Block greift bei
/// status 'active' ODER 'expired' (abgelaufene Pläne müssen weiterhin
/// gecancelt werden, um das gesperrte Guthaben zurückzuholen).

interface TriggerPlanCardProps {
  plan:              TriggerPlanSummary;
  confirming:        boolean;
  cancelling:        boolean;
  onRequestCancel:   () => void;
  onCancelCancel:    () => void;
  onConfirmCancel:   () => void;
  finishConfirming?: boolean;
  finishing?:        boolean;
  onRequestFinish?:  () => void;
  onCancelFinish?:   () => void;
  onConfirmFinish?:  () => void;
}

export default function TriggerPlanCard({
  plan, confirming, cancelling, onRequestCancel, onCancelCancel, onConfirmCancel,
  finishConfirming, finishing, onRequestFinish, onCancelFinish, onConfirmFinish,
}: TriggerPlanCardProps) {
  return (
    <div className={`plan-card plan-card--${triggerPillClass(plan.status)}`}>
      <div className="plan-card__top">
        <a className="plan-card__address" href={`https://celoscan.io/address/${plan.address}`} rel="noreferrer">
          {plan.address.slice(0, 6)}…{plan.address.slice(-4)}
        </a>
        <span className={`pill pill--${triggerPillClass(plan.status)}`}>{TRIGGER_STATUS_LABEL[plan.status]}</span>
      </div>

      {plan.status !== 'pending' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TokenIcon token={(plan.direction === 'buy' ? plan.outputSymbol : plan.heldSymbol) as AnyTokenSymbol} size={20} />
            <span style={{ fontSize: 14, fontWeight: 700 }}>
              {plan.direction === 'buy'
                ? `Buy ${plan.outputSymbol} with ${formatUnits(plan.amountRaw, plan.heldDecimals)} ${plan.heldSymbol}`
                : `Sell ${formatUnits(plan.amountRaw, plan.heldDecimals)} ${plan.heldSymbol} for ${plan.outputSymbol}`}
            </span>
          </div>
          <p className="sell-sub">
            Triggers {plan.direction === 'buy' ? 'at or below' : 'at or above'} ${plan.triggerPriceUsd.toLocaleString()} · {formatExpiry(plan.expiresAt)}
          </p>
          {plan.status === 'active' && (
            <p className="sell-sub sell-sub--muted">
              Checked against the live swap quote price, which can briefly differ from the chart above.
            </p>
          )}
        </>
      )}

      {(plan.status === 'active' || plan.status === 'expired') && (
        confirming ? (
          <div className="plan-card__confirm">
            <p>Cancel this plan? Your locked {plan.heldSymbol} will be returned to your wallet.</p>
            <div className="plan-card__confirm-actions">
              <button type="button" className="btn-ghost" onClick={onCancelCancel}>No, keep it</button>
              <button type="button" className="btn-danger" onClick={onConfirmCancel} disabled={cancelling}>
                {cancelling ? 'Cancelling…' : 'Yes, cancel'}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn-danger" onClick={onRequestCancel}>
            Cancel plan
          </button>
        )
      )}

      {plan.status === 'pending' && (
        plan.canFinish && onRequestFinish ? (
          finishConfirming ? (
            <div className="plan-card__confirm">
              <p>
                This setup never completed — it never received any funds. Finishing it does a tiny placeholder
                setup and cancels it right away, moving it to Cancelled Plans. Nothing is spent (fully refunded),
                only network gas applies.
              </p>
              <div className="plan-card__confirm-actions">
                <button type="button" className="btn-ghost" onClick={onCancelFinish}>Not now</button>
                <button type="button" className="btn-danger" onClick={onConfirmFinish} disabled={finishing}>
                  {finishing ? 'Finishing…' : 'Yes, finish & close'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn-danger" onClick={onRequestFinish}>
              Finish & close
            </button>
          )
        ) : (
          <p className="sell-sub sell-sub--muted">
            This setup never completed — it never received any funds. It's on an older contract generation this
            app can't auto-close yet; no funds are at risk.
          </p>
        )
      )}
    </div>
  );
}
