import { useNavigate } from 'react-router-dom';

/// "My Plans" ist jetzt ein reiner Navigations-Hub statt einer langen,
/// gemischten Liste (siehe Chat: "Wir müssen aber dringend den button 'My
/// plans' wieder in 'Active plans', 'completed plans', 'cancelled plans' und
/// 'my purchases' aufschlüsseln [...] am besten einfach als unterordner.").
/// Bewusst ohne Zähler/Vorab-Ladevorgang hier — jeder Unterordner lädt seine
/// eigenen Daten über usePlans()/Purchases.tsx erst beim Öffnen, damit dieser
/// Hub selbst ohne RPC-Calls sofort erscheint.

interface PlanMenuItem {
  to:    string;
  title: string;
  sub:   string;
}

const PLAN_MENU_ITEMS: PlanMenuItem[] = [
  { to: '/plans/active',    title: 'Active plans',    sub: 'Currently running or awaiting setup' },
  { to: '/plans/completed', title: 'Completed plans', sub: 'Finished DCA & trigger plans' },
  { to: '/plans/cancelled', title: 'Cancelled plans',  sub: 'Plans you cancelled' },
  { to: '/plans/purchases', title: 'My purchases',    sub: 'Full history, grouped by token' },
];

export default function Plans() {
  const navigate = useNavigate();

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/home')} aria-label="Back to Home">
          ‹
        </button>
        <span className="app-bar__title">My Plans</span>
        <span className="app-bar__spacer" />
      </div>

      <div className="menu-list">
        {PLAN_MENU_ITEMS.map((item) => (
          <button
            key={item.to}
            type="button"
            className="menu-item"
            onClick={() => navigate(item.to)}
          >
            <span className="menu-item__text">
              <span className="menu-item__title">{item.title}</span>
              <span className="menu-item__sub">{item.sub}</span>
            </span>
            <span className="menu-item__chev" aria-hidden="true">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
