import { useNavigate } from 'react-router-dom';

/// Platzhalter für Screens, die laut Sprint-Plan (Gesamtplan §23) noch nicht
/// dran sind (Create Code, My Plans, My Holdings, About) — hält die
/// Navigation von Anfang an real testbar, statt Buttons zu deaktivieren.
export default function ComingSoon({ title }: { title: string }) {
  const navigate = useNavigate();

  return (
    <div className="screen screen--sub">
      <div className="app-bar">
        <button type="button" className="app-bar__back" onClick={() => navigate('/home')} aria-label="Back to Home">
          ‹
        </button>
        <span className="app-bar__title">{title}</span>
        <span className="app-bar__spacer" />
      </div>
      <div className="coming-soon">
        <p>{title} is coming soon.</p>
      </div>
    </div>
  );
}
