import { useNavigate } from 'react-router-dom';

/// Öffentlich (siehe App.tsx) — löst das Versprechen aus About.tsx ("See the
/// full Terms of Service ... for details") ein, das bisher auf nichts
/// zeigte. Ton/Struktur bewusst gespiegelt zu OSIRIS' eigener 'terms'-View
/// (src/App.tsx), aber auf APIS' tatsächliche Architektur zugeschnitten
/// (Grant-Codes, angebundene KI-Anbieter, kein eigenes Backend-Statehalten).

export default function Terms() {
  const navigate = useNavigate();

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/about')} aria-label="Back to About">
          ‹
        </button>
        <span className="app-bar__title">Terms &amp; Conditions</span>
        <span className="app-bar__spacer" />
      </div>

      <div className="about-body">
        <p className="about-lede" style={{ fontSize: 12 }}>Last updated: August 2026</p>

        <p className="about-lede">
          APIS, and OSIRIS (the protocol it talks to), are independent, non-commercial projects built by Schmitz
          &amp; Hugenberg for two reasons: to push forward what's technically possible at the intersection of Web3
          and AI agents, and because building this kind of thing is genuinely fun. Neither is a regulated
          financial product, a company, or a service with a business behind it — nothing here constitutes
          financial, investment, tax, or legal advice.
        </p>

        <div className="about-block">
          <h3>Experimental technology, no warranty</h3>
          <p className="about-lede" style={{ fontSize: 13 }}>
            APIS and OSIRIS are built on very new, largely untested combinations of technology — EVM smart
            contracts, cross-chain DEX routing, off-chain price triggers with no on-chain oracle, and AI agents
            (Claude, ChatGPT, Gemini, Grok, and others) proposing transactions on your behalf. All of it — this
            app, its backend, and the OSIRIS contracts it talks to — is provided strictly "as is" and "as
            available", without any warranty of any kind, express or implied, including warranties of
            merchantability, fitness for a particular purpose, non-infringement, availability, accuracy, or
            freedom from errors, bugs, or vulnerabilities. Schmitz &amp; Hugenberg give absolutely no guarantee
            that any part of this will function correctly, securely, continuously, or at all.
          </p>
        </div>

        <div className="about-block">
          <h3>Use at your own risk</h3>
          <p className="about-lede" style={{ fontSize: 13 }}>
            You use APIS and OSIRIS entirely at your own risk and exclusively with your own funds. An AI assistant
            can misunderstand you or propose a plan that doesn't match your intent; smart contracts can fail, be
            exploited, or behave unexpectedly; token prices are volatile and can lose most or all of their value.
            You are solely responsible for reviewing anything an AI proposes before confirming it, and for
            evaluating whether to use APIS or OSIRIS at all. Never commit more than you can afford to lose
            entirely.
          </p>
        </div>

        <div className="about-block">
          <h3>What APIS can and can't do</h3>
          <p className="about-lede" style={{ fontSize: 13 }}>
            An access grant you create in this app lets a connected AI read your balances and propose a plan — it
            can never move funds, sign a transaction, or execute anything by itself. Every action still requires
            your own confirmation and signature in MiniPay. APIS holds no funds and no private keys, ever.
          </p>
        </div>

        <div className="about-block">
          <h3>No liability</h3>
          <p className="about-lede" style={{ fontSize: 13 }}>
            To the fullest extent permitted by law, Schmitz &amp; Hugenberg, their contributors, and anyone
            associated with APIS or OSIRIS accept no liability whatsoever for any direct, indirect, incidental, or
            consequential loss or damage — including loss of funds, tokens, or data — arising from your use of, or
            inability to use, APIS or OSIRIS, whether caused by a smart contract bug, a third-party AI provider
            (Anthropic, OpenAI, Google, xAI, or any other), the Squid Router or any DEX it routes through,
            network/RPC failures, wallet software, or any other cause.
          </p>
        </div>

        <div className="about-block">
          <h3>Research and hobby project, not a business</h3>
          <p className="about-lede" style={{ fontSize: 13 }}>
            APIS and OSIRIS are a research and hobby effort, not a company with support SLAs or roadmap
            commitments. The OSIRIS Telegram group (t.me/osirisapp) is our only official point of contact —
            support there is offered on a best-effort basis and is not guaranteed, and we are not responsible for
            anyone or anything claiming to represent APIS or OSIRIS elsewhere. These terms may change at any time
            without prior notice; continued use of APIS or OSIRIS after a change constitutes acceptance of the
            updated terms.
          </p>
        </div>
      </div>
    </div>
  );
}
