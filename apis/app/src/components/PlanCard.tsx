import { STATUS_LABEL, formatAmount, type PlanSummary } from '../hooks/usePlans';
import { TOKEN_COLOR, type AnyTokenSymbol } from '../tokenVisuals';
import TokenIcon from './TokenIcon';

/// Kartendarstellung für einen einzelnen DCA-Plan — identisch zur bisherigen
/// Inline-Darstellung in Plans.tsx, jetzt als eigene Komponente, damit sie in
/// allen drei Status-Unterordnern (Active/Completed/Cancelled) unverändert
/// wiederverwendet werden kann. Der Cancel-Block greift nur bei status ===
/// 'active', taucht also auf den anderen beiden Screens nie auf.

interface PlanCardProps {
  plan:               PlanSummary;
  confirming:         boolean;
  cancelling:         boolean;
  onRequestCancel:    () => void;
  onCancelCancel:     () => void;
  onConfirmCancel:    () => void;
}

export default function PlanCard({ plan, confirming, cancelling, onRequestCancel, onCancelCancel, onConfirmCancel }: PlanCardProps) {
  return (
    <div className={`plan-card plan-card--${plan.status}`}>
      <div className="plan-card__top">
        <a className="plan-card__address" href={`https://celoscan.io/address/${plan.address}`} rel="noreferrer">
          {plan.address.slice(0, 6)}…{plan.address.slice(-4)}
        </a>
        <span className={`pill pill--${plan.status}`}>{STATUS_LABEL[plan.status]}</span>
      </div>

      {plan.status !== 'pending' && (
        <>
          <div className="plan-card__amount">{formatAmount(plan.totalAmount)} {plan.inputTokenSymbol}</div>

          <div className="plan-card__progress">
            <div className="plan-card__progress-track">
              <div
                className="plan-card__progress-fill"
                style={{ width: `${plan.totalSteps > 0 ? Math.min(100, (plan.currentStep / plan.totalSteps) * 100) : 0}%` }}
              />
            </div>
            <span>{plan.currentStep} / {plan.totalSteps}</span>
          </div>

          {plan.assets.length > 0 && (
            <>
              <div className="plan-card__assets-bar">
                {plan.assets.map((asset) => (
                  <span
                    key={asset.symbol}
                    style={{ width: `${asset.bps / 100}%`, background: TOKEN_COLOR[asset.symbol as AnyTokenSymbol] }}
                  />
                ))}
              </div>
              <div className="plan-card__assets">
                {plan.assets.map((asset) => (
                  <span key={asset.symbol} className="tag">
                    <TokenIcon token={asset.symbol as AnyTokenSymbol} size={15} />
                    {(asset.bps / 100).toFixed(0)}% {asset.symbol}
                  </span>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {plan.status === 'active' && (
        confirming ? (
          <div className="plan-card__confirm">
            <p>Cancel this plan? Your remaining balance will be returned to your wallet.</p>
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
    </div>
  );
}
