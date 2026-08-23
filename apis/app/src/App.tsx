import { Navigate, Route, Routes } from 'react-router-dom';
import { useConnection } from 'wagmi';
import Landing from './screens/Landing';
import Home from './screens/Home';
import Holdings from './screens/Holdings';
import CreateCode from './screens/CreateCode';
import About from './screens/About';
import ComingSoon from './screens/ComingSoon';

/// Schützt Screens, die eine Verbindung voraussetzen — leitet sonst zurück
/// zu Landing, wo der Auto-Connect (bzw. der Tap-to-Reconnect) greift.
function RequireConnection({ children }: { children: React.ReactNode }) {
  const { isConnected } = useConnection();
  if (!isConnected) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/home" element={<RequireConnection><Home /></RequireConnection>} />
      <Route
        path="/create-code"
        element={<RequireConnection><CreateCode /></RequireConnection>}
      />
      <Route
        path="/plans"
        element={<RequireConnection><ComingSoon title="My Plans" /></RequireConnection>}
      />
      <Route
        path="/holdings"
        element={<RequireConnection><Holdings /></RequireConnection>}
      />
      <Route
        path="/about"
        element={<RequireConnection><About /></RequireConnection>}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
