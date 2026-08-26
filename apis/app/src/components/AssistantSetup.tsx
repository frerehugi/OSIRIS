import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

/// Gemeinsames Gerüst für die vier Setup-Anleitungen (/claude, /chatgpt,
/// /gemini, /grok) — bewusst PUBLIC (kein RequireConnection in App.tsx),
/// da diese Seiten reine Anleitungen sind, keinen Wallet-Zugriff brauchen,
/// und über OSIRIS bzw. geteilte Links auch außerhalb von MiniPay lesbar
/// sein sollen (siehe Chat: "entsprechende Infos bekommen und die tools ...
/// laden können").

interface AssistantSetupProps {
  name:      string;
  emoji:     string;
  tagline:   string;
  steps:     ReactNode[];
  copyLabel: string;
  copyUrl:   string;
  note?:     ReactNode;
}

export default function AssistantSetup({ name, emoji, tagline, steps, copyLabel, copyUrl, note }: AssistantSetupProps) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(copyUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/connect')} aria-label="Back to Connect Your AI">
          ‹
        </button>
        <span className="app-bar__title">{emoji} {name}</span>
        <span className="app-bar__spacer" />
      </div>

      <p className="createcode-sub">{tagline}</p>

      <div className="section-label">Setup</div>
      <div className="sell-card">
        <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {steps.map((step, i) => <li key={i}>{step}</li>)}
        </ol>
      </div>

      <div className="section-label">{copyLabel}</div>
      <div className="code-card">
        <div className="code-card__code">{copyUrl}</div>
        <button type="button" className="code-card__copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {note && <p className="fee-note">{note}</p>}

      <p className="createcode-sub">
        Once {name} is connected, come back here any time and generate a one-time code — that's what lets it
        actually see your wallet or propose a plan.
      </p>

      <button type="button" className="btn-gold" onClick={() => navigate('/create-code')} style={{ margin: '4px 18px 24px' }}>
        Next: Create your first code →
      </button>
    </div>
  );
}
