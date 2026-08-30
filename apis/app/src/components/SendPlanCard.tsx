import { formatUnits } from 'viem';
import { STATUS_LABEL, type SendPlanSummary } from '../hooks/usePlans';

// Eigene Formatierung statt usePlans.ts' formatAmount() — die geht hart von
// 6 Decimals aus (USDC/USDT, die einzigen DCA-Input-Token). SendVault kann
// aber jeden sendTokens-Eintrag verschicken, u.a. 18-Decimal-Token (CELO,
// wETH, cUSD) und wBTC (8) — formatAmount() würde diese massiv falsch anzeigen.
function formatSendAmount(raw: bigint, decimals: number): string {
  return Number(formatUnits(raw, decimals)).toFixed(2);
}

/// Kartendarstellung für einen einzelnen Send-Plan (Multi-Empfänger-Payout,
/// siehe SendVault.sol) — gleiches Muster wie PlanCard.tsx/TriggerPlanCard.tsx,
/// in allen drei Status-Unterordnern (Active/Completed/Cancelled) wiederverwendet.
/// Der Cancel-Block greift nur bei status === 'active', wie bei PlanCard.

interface SendPlanCardProps {
  plan:            SendPlanSummary;
  confirming:      boolean;
  cancelling:      boolean;
  onRequestCancel: () => void;
  onCancelCancel:  () => void;
  onConfirmCancel: () => void;
}

export default function SendPlanCard({ plan, confirming, cancelling, onRequestCancel, onCancelCancel, onConfirmCancel }: SendPlanCardProps) {
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
          <div className="plan-card__amount">{formatSendAmount(plan.totalAmount, plan.tokenDecimals)} {plan.tokenSymbol}</div>

          <div className="plan-card__progress">
            <div className="plan-card__progress-track">
              <div
                className="plan-card__progress-fill"
                style={{ width: `${plan.totalSteps > 0 ? Math.min(100, (plan.currentStep / plan.totalSteps) * 100) : 0}%` }}
              />
            </div>
            <span>{plan.currentStep} / {plan.totalSteps}</span>
          </div>

          <p className="sell-sub">
            {plan.recipients.length} recipient{plan.recipients.length === 1 ? '' : 's'}
            {plan.recipients.length > 0 && (
              <> · {formatUnits(plan.recipients[0].totalAmount, plan.tokenDecimals)} {plan.tokenSymbol}{plan.recipients.length > 1 ? ' each' : ''}</>
            )}
          </p>
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
