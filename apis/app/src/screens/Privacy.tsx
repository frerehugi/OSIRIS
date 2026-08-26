import { useNavigate } from 'react-router-dom';

/// Öffentlich (siehe App.tsx) — löst dasselbe Versprechen aus About.tsx wie
/// Terms.tsx ein. Anders als OSIRIS' eigene Privacy Policy (die explizit
/// "kein eigenes Backend" behauptet) hat Apis eins (apis/backend, siehe
/// apis/backend/src/) — dieser Text ist bewusst eigenständig formuliert,
/// keine Kopie von OSIRIS', da die Architektur wirklich unterschiedlich ist.

export default function Privacy() {
  const navigate = useNavigate();

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/about')} aria-label="Back to About">
          ‹
        </button>
        <span className="app-bar__title">Privacy Policy</span>
        <span className="app-bar__spacer" />
      </div>

      <div className="about-body">
        <p className="about-lede" style={{ fontSize: 12 }}>Last updated: August 2026</p>

        <p className="about-lede">
          Apis is a non-commercial passion project by Schmitz &amp; Hugenberg. Neither this app nor its backend
          uses analytics or tracking scripts, and neither asks for or stores personal information (name, email,
          phone number, etc.) — MiniPay identifies you to Apis only by your public wallet address.
        </p>

        <div className="about-block">
          <h3>Access grants</h3>
          <p className="about-lede" style={{ fontSize: 13 }}>
            The one-time code you generate in "Create New Code for Agent" is a self-contained, signed message —
            not a stored credential. Apis' backend never saves it anywhere; each time it's used, it only verifies
            the signature and expiry, then discards it. Whichever AI provider you paste it into (Anthropic,
            OpenAI, Google, xAI, or another) sees and handles that code according to their own privacy practices,
            outside Apis' control.
          </p>
        </div>

        <div className="about-block">
          <h3>On-chain data</h3>
          <p className="about-lede" style={{ fontSize: 13 }}>
            Your wallet address, transactions, and vault activity are recorded on the public Celo blockchain by
            design — that's how any blockchain works, and it's outside Apis' or OSIRIS's control. Anyone can view
            this public on-chain data (e.g. via Celoscan), independent of this app.
          </p>
        </div>

        <div className="about-block">
          <h3>Backend &amp; third parties</h3>
          <p className="about-lede" style={{ fontSize: 13 }}>
            Apis' backend runs as a stateless Cloudflare Worker — no database, nothing kept between requests. To
            answer a request it talks directly to public Celo RPC nodes to read blockchain data. Requests reach it
            either from this app or from whichever AI provider you've connected — both can see your wallet address
            and IP address as part of normal network requests. Apis does not control those parties' own data
            handling — see their respective policies.
          </p>
        </div>

        <div className="about-block">
          <h3>Local storage</h3>
          <p className="about-lede" style={{ fontSize: 13 }}>
            This app may cache a small amount of already-seen data (like plan or purchase history) on your own
            device (browser/WebView local storage), purely to speed up loading. It never leaves your device and is
            not accessible to us.
          </p>
        </div>

        <p className="about-lede" style={{ fontSize: 13 }}>Questions about this policy: t.me/osirisapp.</p>
      </div>
    </div>
  );
}
