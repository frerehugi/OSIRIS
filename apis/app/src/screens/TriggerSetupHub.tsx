import { useNavigate } from 'react-router-dom';

/// "Set up" — Einstieg in den Trigger-Plan-Flow (siehe Chat). Ersetzt den
/// früheren direkten Sell-Trigger-Screen: Buy- und Sell-Pläne laufen jetzt
/// beide über denselben TriggerVault-Mechanismus (contracts/TriggerVault.sol),
/// nur mit vertauschten Token — siehe TriggerPlanReview.tsx.
export default function TriggerSetupHub() {
  const navigate = useNavigate();

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/home')} aria-label="Back to Home">
          ‹
        </button>
        <span className="app-bar__title">Set up</span>
        <span className="app-bar__spacer" />
      </div>

      <p className="createcode-sub">
        Create a plan that buys or sells automatically once your price is hit — no need to watch the market yourself.
      </p>

      <div className="menu-list">
        <button type="button" className="menu-item" onClick={() => navigate('/trigger-setup/buy')}>
          <span className="menu-item__text">
            <span className="menu-item__title">New Buy Plan</span>
            <span className="menu-item__sub">Buy a coin once it hits your price</span>
          </span>
          <span className="menu-item__chev" aria-hidden="true">›</span>
        </button>

        <button type="button" className="menu-item" onClick={() => navigate('/trigger-setup/sell')}>
          <span className="menu-item__text">
            <span className="menu-item__title">New Sell Plan</span>
            <span className="menu-item__sub">Sell a holding once it hits your price</span>
          </span>
          <span className="menu-item__chev" aria-hidden="true">›</span>
        </button>
      </div>
    </div>
  );
}
