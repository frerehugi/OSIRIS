import PlanStatusScreen from '../components/PlanStatusScreen';

export default function CompletedPlans() {
  return (
    <PlanStatusScreen
      title="Completed Plans"
      dcaStatuses={['complete']}
      triggerStatuses={['executed']}
      emptyDca="No completed DCA plans yet."
      emptyTrigger="No completed trigger plans yet."
    />
  );
}
