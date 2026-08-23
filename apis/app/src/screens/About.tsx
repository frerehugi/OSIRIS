import { useNavigate } from 'react-router-dom';

/// Letzter Screen aus dem Mockup — Inhalt 1:1 von dort übernommen (siehe
/// apis-mockup.html, Step "About Apis"). Vier Pflichtelemente laut
/// Gesamtplan §4: Kurzbeschreibung, Terms & Conditions, Contact
/// (OSIRIS-Telegram), Credit-Zeile.
export default function About() {
  const navigate = useNavigate();

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/home')} aria-label="Back to Home">
          ‹
        </button>
        <span className="app-bar__title">About Apis</span>
        <span className="app-bar__spacer" />
      </div>

      <div className="about-body">
        <p className="about-lede">
          Apis connects your AI assistant to the OSIRIS protocol on Celo. It never holds your funds or private
          keys — it only reads your wallet and proposes plans that you confirm yourself in MiniPay.
        </p>

        <div className="about-block">
          <h3>Terms &amp; Conditions</h3>
          <ul className="about-list">
            <li>Apis is a non-custodial interface only. It cannot move, freeze, or access your funds.</li>
            <li>
              AI-generated plans are suggestions, not financial advice — you are responsible for reviewing
              every plan before confirming it.
            </li>
            <li>Digital asset prices are volatile. Past performance does not indicate future results.</li>
            <li>
              Access grants are limited to reading balances and proposing plans — never to executing
              transactions without your explicit confirmation.
            </li>
            <li>
              Use of Apis and OSIRIS is entirely at your own risk. See the full Terms of Service and Privacy
              Policy for details.
            </li>
          </ul>
        </div>

        <div className="about-block">
          <h3>Support</h3>
          <div className="about-support">
            <div className="about-support__icon" aria-hidden="true">T</div>
            <div>
              <div className="about-support__title">OSIRIS Support</div>
              <div className="about-support__sub">Telegram · same channel as OSIRIS</div>
            </div>
          </div>
        </div>

        <div className="about-version">Apis v0.1 · pre-release</div>
        <div className="about-credit">Built by Schmitz &amp; Hugenberg</div>
      </div>
    </div>
  );
}
