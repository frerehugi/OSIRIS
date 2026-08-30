import PlanStatusScreen from '../components/PlanStatusScreen';

export default function CancelledPlans() {
  return (
    <PlanStatusScreen
      title="Cancelled Plans"
      dcaStatuses={['cancelled']}
      triggerStatuses={['cancelled']}
      sendStatuses={['cancelled']}
      emptyDca="No cancelled DCA plans."
      emptyTrigger="No cancelled trigger plans."
      emptySend="No cancelled send plans."
    />
  );
}
