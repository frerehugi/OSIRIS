import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection } from 'wagmi';
import { useAutoConnect } from '../wallet';

/// Landing ist zugleich Einstiegs- UND Wiedereinstiegspunkt (siehe
/// Gesamtplan §14 "Re-Entry"). Kein "Connect"-Button — das Apis-Logo selbst
/// ist der Tap-Ziel für einen erneuten Verbindungsversuch, ein neutraler
/// Marken-Tap statt eines expliziten Connect-Elements (MiniPay-Pflichtregel).
/// Zeigt bewusst keinen "Connecting…"-Zwischenzustand, nur Fehler.
export default function Landing() {
  const navigate = useNavigate();
  const { isConnected } = useConnection();
  const { error, retry, providerMissing } = useAutoConnect();

  useEffect(() => {
    if (isConnected) navigate('/home', { replace: true });
  }, [isConnected, navigate]);

  return (
    <div className="screen screen--landing">
      <button
        type="button"
        className="landing-mark"
        onClick={retry}
        aria-label="Apis — tap to retry connecting"
      >
        <span className="landing-mark__glyph">A</span>
      </button>
      <h1 className="landing-word">Apis</h1>
      <p className="landing-tagline">Agentic Powered Investment System</p>

      {providerMissing && (
        <p className="landing-error">
          Open this app inside MiniPay to continue.
        </p>
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
