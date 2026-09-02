import { useNavigate } from 'react-router-dom';
import { usePlans, type PlanSummary, type TriggerPlanSummary, type VaultStatus, type TriggerPlanStatus } from '../hooks/usePlans';
import PlanCard from './PlanCard';
import TriggerPlanCard from './TriggerPlanCard';

/// Gemeinsames Gerüst für die drei Status-Unterordner (Active/Completed/
/// Cancelled Plans) — nur Titel, Status-Filter und Leertexte unterscheiden
/// sich zwischen ihnen, siehe ActivePlans.tsx/CompletedPlans.tsx/
/// CancelledPlans.tsx.

interface PlanStatusScreenProps {
  title:            string;
  dcaStatuses:      VaultStatus[];
  triggerStatuses:  TriggerPlanStatus[];
  emptyDca:         string;
  emptyTrigger:     string;
}

export default function PlanStatusScreen({ title, dcaStatuses, triggerStatuses, emptyDca, emptyTrigger }: PlanStatusScreenProps) {
  const navigate = useNavigate();
  const {
    plans, plansLoading, plansError,
    confirmingAddress, setConfirmingAddress, cancellingAddress, cancelError, confirmCancel,
    finishConfirmingAddress, setFinishConfirmingAddress, finishingAddress, finishError, finishPendingPlan,
    triggerPlans, triggerPlansLoading, triggerCancelError,
    triggerConfirmingAddress, setTriggerConfirmingAddress, triggerCancellingAddress, confirmTriggerCancel,
    triggerFinishConfirmingAddress, setTriggerFinishConfirmingAddress,
    triggerFinishingAddress, triggerFinishError, finishPendingTriggerPlan,
  } = usePlans();

  const dcaFiltered: PlanSummary[] | null = plans?.filter((p) => dcaStatuses.includes(p.status)) ?? null;
  const triggerFiltered: TriggerPlanSummary[] = triggerPlans.filter((p) => triggerStatuses.includes(p.status));

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/plans')} aria-label="Back to My Plans">
          ‹
        </button>
        <span className="app-bar__title">{title}</span>
        <span className="app-bar__spacer" />
      </div>

      <div className="section-label">DCA Plans</div>
      {plansLoading && <p className="plans-note">Loading your plans…</p>}
      {plansError && <p className="createcode-error">{plansError}</p>}
      {cancelError && <p className="createcode-error">{cancelError}</p>}
      {finishError && <p className="createcode-error">{finishError}</p>}
      {!plansLoading && !plansError && dcaFiltered?.length === 0 && (
        <p className="plans-note">{emptyDca}</p>
      )}
      <div className="plan-list">
        {dcaFiltered?.map((plan) => (
          <PlanCard
            key={plan.address}
            plan={plan}
            confirming={confirmingAddress === plan.address}
            cancelling={cancellingAddress === plan.address}
            onRequestCancel={() => setConfirmingAddress(plan.address)}
            onCancelCancel={() => setConfirmingAddress(null)}
            onConfirmCancel={() => confirmCancel(plan.address)}
            finishConfirming={finishConfirmingAddress === plan.address}
            finishing={finishingAddress === plan.address}
            onRequestFinish={() => setFinishConfirmingAddress(plan.address)}
            onCancelFinish={() => setFinishConfirmingAddress(null)}
            onConfirmFinish={() => finishPendingPlan(plan.address)}
          />
        ))}
      </div>

      <div className="section-label" style={{ marginTop: 8 }}>Trigger Plans</div>
      {triggerPlansLoading && <p className="plans-note">Loading your trigger plans…</p>}
      {triggerCancelError && <p className="createcode-error">{triggerCancelError}</p>}
      {triggerFinishError && <p className="createcode-error">{triggerFinishError}</p>}
      {!triggerPlansLoading && triggerFiltered.length === 0 && (
        <p className="plans-note">{emptyTrigger}</p>
      )}
      <div className="plan-list">
        {triggerFiltered.map((plan) => (
          <TriggerPlanCard
            key={plan.address}
            plan={plan}
            confirming={triggerConfirmingAddress === plan.address}
            cancelling={triggerCancellingAddress === plan.address}
            onRequestCancel={() => setTriggerConfirmingAddress(plan.address)}
            onCancelCancel={() => setTriggerConfirmingAddress(null)}
            onConfirmCancel={() => confirmTriggerCancel(plan.address)}
            finishConfirming={triggerFinishConfirmingAddress === plan.address}
            finishing={triggerFinishingAddress === plan.address}
            onRequestFinish={() => setTriggerFinishConfirmingAddress(plan.address)}
            onCancelFinish={() => setTriggerFinishConfirmingAddress(null)}
            onConfirmFinish={() => finishPendingTriggerPlan(plan.address)}
          />
        ))}
      </div>
    </div>
  );
}
