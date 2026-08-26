import AssistantSetup from '../components/AssistantSetup';

export default function ConnectChatGPT() {
  return (
    <AssistantSetup
      name="ChatGPT"
      emoji="🟢"
      tagline="Add Apis as an Action on a Custom GPT."
      steps={[
        'In ChatGPT, create a new Custom GPT (or edit one you already made) → Configure → Actions → Create new action.',
        'Choose "Import from URL" and paste the schema URL below.',
        'Set Authentication to "None".',
        'Save your GPT — the four Apis tools now show up as Actions it can call.',
      ]}
      copyLabel="OpenAPI Schema URL"
      copyUrl="https://apis-backend.frerehugi.workers.dev/openapi.json"
    />
  );
}
