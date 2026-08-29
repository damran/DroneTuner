import { Route, Routes } from "react-router-dom";
import AppShell from "./components/layout/AppShell";
import ErrorBoundary from "./components/ErrorBoundary";
import FleetPage from "./pages/FleetPage";
import DroneDetailPage from "./pages/DroneDetailPage";
import LogLabPage from "./pages/LogLabPage";
import ProfilesPage from "./pages/ProfilesPage";
import WizardPage from "./pages/WizardPage";
import GuidePage from "./pages/GuidePage";

export default function App() {
  return (
    <AppShell>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<FleetPage />} />
          <Route path="/drones/:id" element={<DroneDetailPage />} />
          <Route path="/logs" element={<LogLabPage />} />
          <Route path="/profiles" element={<ProfilesPage />} />
          <Route path="/wizard" element={<WizardPage />} />
          <Route path="/guide" element={<GuidePage />} />
        </Routes>
      </ErrorBoundary>
    </AppShell>
  );
}
