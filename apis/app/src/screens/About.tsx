import { useNavigate } from 'react-router-dom';
import { useConnection } from 'wagmi';

/// Bewusst PUBLIC (siehe App.tsx) — auch ohne Wallet-Verbindung lesbar, z.B.
/// verlinkt von osirisapp.xyz. "Zurück" geht deshalb zu /home nur, wenn
/// tatsächlich verbunden, sonst zu / (Landing).
///
/// Ursprünglich 1:1 aus dem Mockup übernommen (siehe apis-mockup.html, Step
/// "About Apis"), jetzt erweitert um eine klare Erklärung, was Apis/OSIRIS
/// überhaupt sind, plus Cross-Links in beide Richtungen (siehe Chat: "über
/// osirisapp.xyz auch zu APIS gelangen können [...] und umgekehrt").
export default function About() {
  const navigate = useNavigate();
  const { isConnected } = useConnection();

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button
          type="button"
          className="app-bar__back"
          onClick={() => navigate(isConnected ? '/home' : '/')}
          aria-label="Back"
        >
          ‹
        </button>
        <span className="app-bar__title">About Apis</span>
        <span className="app-bar__spacer" />
      </div>

      <div className="about-body">
        <p className="about-lede">
          <strong>OSIRIS</strong> is a set of smart contracts on Celo that automatically buy crypto for you on a
          schedule (dollar-cost averaging), or the moment a price you set is hit (buy/sell triggers) — all from a
          vault only you control. <strong>Apis</strong> is how you talk to it: it lets your AI assistant (Claude,
          ChatGPT, Gemini, Grok) read your balances and put together an OSIRIS plan for you to review — in plain
          language, in the chat you already use. Apis never holds your funds or private keys, and no plan runs
          until you confirm and sign it yourself in MiniPay.
        </p>

        <div className="about-block">
          <h3>Get started</h3>
          <button type="button" className="menu-item" onClick={() => navigate('/connect')} style={{ marginTop: 4 }}>
            <span className="menu-item__text">
              <span className="menu-item__title">Connect your AI assistant</span>
              <span className="menu-item__sub">Claude, ChatGPT, Gemini, or Grok</span>
            </span>
            <span className="menu-item__chev" aria-hidden="true">›</span>
          </button>
        </div>

        <div className="about-block">
          <h3>Legal</h3>
          <p className="about-lede" style={{ fontSize: 13 }}>
            Apis is a non-custodial interface only — it cannot move, freeze, or access your funds. AI-generated
            plans are suggestions, not financial advice; you're responsible for reviewing every plan before
            confirming it. Apis and OSIRIS are experimental, non-commercial projects — use is entirely at your own
            risk.
          </p>
          <button type="button" className="menu-item" onClick={() => navigate('/terms')} style={{ marginTop: 4 }}>
            <span className="menu-item__text">
              <span className="menu-item__title">Terms &amp; Conditions</span>
              <span className="menu-item__sub">Full disclaimer</span>
            </span>
            <span className="menu-item__chev" aria-hidden="true">›</span>
          </button>
          <button type="button" className="menu-item" onClick={() => navigate('/privacy')} style={{ marginTop: 10 }}>
            <span className="menu-item__text">
              <span className="menu-item__title">Privacy Policy</span>
              <span className="menu-item__sub">What we do (and don't) collect</span>
            </span>
            <span className="menu-item__chev" aria-hidden="true">›</span>
          </button>
        </div>

        <div className="about-block">
          <h3>Contact</h3>
          <a href="https://t.me/osirisapp" rel="noreferrer" className="about-support" style={{ textDecoration: 'none' }}>
            <div className="about-support__icon" aria-hidden="true">T</div>
            <div>
              <div className="about-support__title">OSIRIS Telegram group</div>
              <div className="about-support__sub">Our only official point of contact</div>
            </div>
          </a>
        </div>

        <a href="https://osirisapp.xyz" rel="noreferrer" className="about-lede" style={{ fontSize: 13 }}>
          Learn more about the OSIRIS protocol at osirisapp.xyz ↗
        </a>

        <div className="about-version">Apis v0.1 · pre-release</div>
        <div className="about-credit">Built by Schmitz &amp; Hugenberg</div>
      </div>
    </div>
  );
}
