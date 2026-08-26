import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection } from 'wagmi';
import { useAutoConnect } from '../wallet';

/// Landing ist zugleich Einstiegs- UND Wiedereinstiegspunkt (siehe
/// Gesamtplan §14 "Re-Entry"). Kein "Connect"-Button — das Apis-Bild selbst
/// ist der Tap-Ziel für einen erneuten Verbindungsversuch, ein neutraler
/// Marken-Tap statt eines expliziten Connect-Elements (MiniPay-Pflichtregel).
/// Zeigt bewusst keinen "Connecting…"-Zwischenzustand, nur Fehler.
///
/// Bild + Überschrift darunter — exakt dieselbe Struktur wie OSIRIS' eigener
/// Connect-View (<img className="banner"/><h1>OSIRIS</h1>, siehe src/App.tsx)
/// — "Apis als Bruder von OSIRIS erkennbar", siehe Chat.
export default function Landing() {
  const navigate = useNavigate();
  const { isConnected } = useConnection();
  const { error, retry, providerMissing } = useAutoConnect();

  useEffect(() => {
    if (isConnected) navigate('/home', { replace: true });
  }, [isConnected, navigate]);

  return (
    <div className="screen screen--landing">
      <button type="button" className="landing-banner-btn" onClick={retry} aria-label="Apis — tap to retry connecting">
        <img src="/apis-banner.jpg" alt="Apis" className="landing-banner" />
      </button>
      <h1>Apis</h1>
      <p className="landing-tagline">Agentic Powered Investment System</p>

      {providerMissing && (
        <>
          <p className="landing-error">
            Open this app inside MiniPay to connect your wallet — but you can still look around from here.
          </p>
          <button type="button" className="btn-gold" onClick={() => navigate('/about')}>
            What is Apis?
          </button>
          <button type="button" className="btn-gold" onClick={() => navigate('/connect')} style={{ marginTop: 10 }}>
            Connect your AI
          </button>
        </>
      )}
      {!providerMissing && error && (
        <p className="landing-error">
          Could not connect to MiniPay. Tap the logo to try again.
        </p>
      )}

      <p className="landing-foot">Powered by MiniPay</p>
    </div>
  );
}
