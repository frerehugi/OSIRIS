import PlanStatusScreen from '../components/PlanStatusScreen';

export default function ActivePlans() {
  return (
    <PlanStatusScreen
      title="Active Plans"
      dcaStatuses={['pending', 'active']}
      triggerStatuses={['pending', 'active', 'expired']}
      sendStatuses={['pending', 'active']}
      emptyDca="No active DCA plans yet. Set one up by chatting with your AI assistant."
      emptyTrigger="No active buy/sell trigger plans yet."
      emptySend="No active send plans yet."
    />
  );
}
