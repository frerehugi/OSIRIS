import { useNavigate } from 'react-router-dom';

/// Öffentlicher Einstiegspunkt für "connect your AI" — bewusst kein
/// RequireConnection (siehe App.tsx), damit ein Link von osirisapp.xyz
/// oder ein geteilter Link auch außerhalb von MiniPay funktioniert.

interface AssistantLink {
  to:    string;
  emoji: string;
  title: string;
  sub:   string;
}

const ASSISTANTS: AssistantLink[] = [
  { to: '/claude',  emoji: '🟠', title: 'Claude',  sub: 'Custom connector — Claude app & claude.ai' },
  { to: '/chatgpt', emoji: '🟢', title: 'ChatGPT', sub: 'Custom GPT Action' },
  { to: '/gemini',  emoji: '🔵', title: 'Gemini',  sub: 'Gem / Extension' },
  { to: '/grok',    emoji: '⚫', title: 'Grok',    sub: 'Manual function setup' },
];

export default function ConnectAI() {
  const navigate = useNavigate();

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/about')} aria-label="Back to About">
          ‹
        </button>
        <span className="app-bar__title">Connect Your AI</span>
        <span className="app-bar__spacer" />
      </div>

      <p className="createcode-sub">
        Pick the assistant you use. You add APIS as a tool there once — then, any time you want it to check your
        wallet or propose a plan, you generate a one-time code in this app and paste it into that chat.
      </p>

      <div className="menu-list">
        {ASSISTANTS.map((a) => (
          <button key={a.to} type="button" className="menu-item" onClick={() => navigate(a.to)}>
            <span className="menu-item__text">
              <span className="menu-item__title">{a.emoji} {a.title}</span>
              <span className="menu-item__sub">{a.sub}</span>
            </span>
            <span className="menu-item__chev" aria-hidden="true">›</span>
          </button>
        ))}
      </div>

      <p className="createcode-sub">
        APIS never holds your funds or private keys — a connected assistant can only read balances and propose
        plans. Nothing moves until you confirm and sign it yourself in MiniPay.
      </p>
    </div>
  );
}
