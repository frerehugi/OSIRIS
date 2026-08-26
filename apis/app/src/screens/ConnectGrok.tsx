import AssistantSetup from '../components/AssistantSetup';

export default function ConnectGrok() {
  return (
    <AssistantSetup
      name="Grok"
      emoji="⚫"
      tagline="Grok doesn't (yet) offer a one-click OpenAPI import — point it at the schema directly."
      steps={[
        'Give Grok the schema URL below and ask it to read/use it — most current versions can fetch and act on it directly.',
        'If your setup needs manual function definitions instead, use the schema as the source: each path (/capabilities, /balances, /plans, /propose) maps to one function.',
      ]}
      copyLabel="OpenAPI Schema URL"
      copyUrl="https://apis-backend.frerehugi.workers.dev/openapi.json"
      note="Support varies by Grok version — this is the most future-proof entry point either way."
    />
  );
}
