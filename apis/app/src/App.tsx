import { Navigate, Route, Routes } from 'react-router-dom';
import { useConnection } from 'wagmi';
import Landing from './screens/Landing';
import Home from './screens/Home';
import Holdings from './screens/Holdings';
import Plans from './screens/Plans';
import ActivePlans from './screens/ActivePlans';
import CompletedPlans from './screens/CompletedPlans';
import CancelledPlans from './screens/CancelledPlans';
import Purchases from './screens/Purchases';
import CreateCode from './screens/CreateCode';
import ConfirmPlan from './screens/ConfirmPlan';
import About from './screens/About';
import ConnectAI from './screens/ConnectAI';
import ConnectClaude from './screens/ConnectClaude';
import ConnectChatGPT from './screens/ConnectChatGPT';
import ConnectGemini from './screens/ConnectGemini';
import ConnectGrok from './screens/ConnectGrok';

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
        element={<RequireConnection><Plans /></RequireConnection>}
      />
      <Route
        path="/plans/active"
        element={<RequireConnection><ActivePlans /></RequireConnection>}
      />
      <Route
        path="/plans/completed"
        element={<RequireConnection><CompletedPlans /></RequireConnection>}
      />
      <Route
        path="/plans/cancelled"
        element={<RequireConnection><CancelledPlans /></RequireConnection>}
      />
      <Route
        path="/plans/purchases"
        element={<RequireConnection><Purchases /></RequireConnection>}
      />
      <Route
        path="/confirm-plan"
        element={<RequireConnection><ConfirmPlan /></RequireConnection>}
      />
      <Route
        path="/holdings"
        element={<RequireConnection><Holdings /></RequireConnection>}
      />
      {/* Öffentlich — kein RequireConnection: reine Infos/Anleitungen, auch
          außerhalb von MiniPay lesbar (z.B. verlinkt von osirisapp.xyz oder
          geteilt), siehe Chat "entsprechende Infos bekommen ... tools laden". */}
      <Route path="/about" element={<About />} />
      <Route path="/connect" element={<ConnectAI />} />
      <Route path="/claude" element={<ConnectClaude />} />
      <Route path="/chatgpt" element={<ConnectChatGPT />} />
      <Route path="/gemini" element={<ConnectGemini />} />
      <Route path="/grok" element={<ConnectGrok />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
