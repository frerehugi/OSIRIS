import { useNavigate } from 'react-router-dom';

interface MenuItem {
  to:    string;
  title: string;
  sub:   string;
}

const MENU_ITEMS: MenuItem[] = [
  { to: '/create-code', title: 'Create New Code for Agent', sub: 'Grant your AI temporary access' },
  { to: '/plans',       title: 'My Plans',                  sub: 'Active plans & purchase history' },
  { to: '/holdings',    title: 'My Holdings',                sub: 'USDC · USDT · CELO · XAUoT · wBTC · wETH' },
  { to: '/sell-trigger', title: 'Sell Trigger',              sub: 'Sell automatically once a price is hit' },
  { to: '/about',       title: 'About Apis',                 sub: 'Terms, disclaimer & support' },
];

export default function Home() {
  const navigate = useNavigate();

  return (
    <div className="screen screen--home">
      <div className="home-head">
        <div className="home-head__mark">A</div>
        <div className="home-head__word">Apis</div>
      </div>

      <div className="menu-list">
        {MENU_ITEMS.map((item) => (
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
