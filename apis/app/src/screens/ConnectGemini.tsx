import AssistantSetup from '../components/AssistantSetup';

export default function ConnectGemini() {
  return (
    <AssistantSetup
      name="Gemini"
      emoji="🔵"
      tagline="Add APIS as a custom action on a Gem."
      steps={[
        'In Gemini, open Gems (or Extensions — naming varies by account) → create a custom action.',
        'Import the OpenAPI schema from the URL below.',
        'No authentication required.',
        'Save — Gemini can now call APIS\' tools inside that Gem.',
      ]}
      copyLabel="OpenAPI Schema URL"
      copyUrl="https://apis-backend.frerehugi.workers.dev/openapi.json"
      note="Google changes this UI fairly often — if you don't see an import-by-URL option under Gems, look for Extensions/Actions in your account settings instead."
    />
  );
}
