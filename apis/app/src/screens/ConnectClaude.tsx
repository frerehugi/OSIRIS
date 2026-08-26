import AssistantSetup from '../components/AssistantSetup';

export default function ConnectClaude() {
  return (
    <AssistantSetup
      name="Claude"
      emoji="🟠"
      tagline="Add APIS as a custom connector — works in the Claude app and at claude.ai."
      steps={[
        'In Claude, open Settings → Connectors → Add custom connector.',
        'Paste the URL below into the connector URL field.',
        'Set Authentication to "None" and save.',
        'In any chat where you want to use it, enable "APIS" from that conversation\'s tools/connectors picker — adding it once does not turn it on everywhere automatically.',
      ]}
      copyLabel="Connector URL"
      copyUrl="https://apis-backend.frerehugi.workers.dev"
    />
  );
}
