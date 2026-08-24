import { Navigate, Route, Routes } from 'react-router-dom';
import { useConnection } from 'wagmi';
import Landing from './screens/Landing';
import Home from './screens/Home';
import Holdings from './screens/Holdings';
import Plans from './screens/Plans';
import CreateCode from './screens/CreateCode';
import ConfirmPlan from './screens/ConfirmPlan';
import TriggerSetupHub from './screens/TriggerSetupHub';
import BuyPlanCoinSelect from './screens/BuyPlanCoinSelect';
import BuyPlanDetails from './screens/BuyPlanDetails';
import SellPlanCoinSelect from './screens/SellPlanCoinSelect';
import SellPlanDetails from './screens/SellPlanDetails';
import TriggerPlanReview from './screens/TriggerPlanReview';
import About from './screens/About';

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
        path="/confirm-plan"
        element={<RequireConnection><ConfirmPlan /></RequireConnection>}
      />
      <Route
        path="/holdings"
        element={<RequireConnection><Holdings /></RequireConnection>}
      />
      <Route
        path="/trigger-setup"
        element={<RequireConnection><TriggerSetupHub /></RequireConnection>}
      />
      <Route
        path="/trigger-setup/buy"
        element={<RequireConnection><BuyPlanCoinSelect /></RequireConnection>}
      />
      <Route
        path="/trigger-setup/buy/details"
        element={<RequireConnection><BuyPlanDetails /></RequireConnection>}
      />
      <Route
        path="/trigger-setup/sell"
        element={<RequireConnection><SellPlanCoinSelect /></RequireConnection>}
      />
      <Route
        path="/trigger-setup/sell/details"
        element={<RequireConnection><SellPlanDetails /></RequireConnection>}
      />
      <Route
        path="/trigger-setup/review"
        element={<RequireConnection><TriggerPlanReview /></RequireConnection>}
      />
      <Route
        path="/about"
        element={<RequireConnection><About /></RequireConnection>}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
