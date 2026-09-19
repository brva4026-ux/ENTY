import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./index.css";
import { AuthProvider, useAuth } from "./lib/auth";
import { UIProvider } from "./lib/ui";
import { OfflineBanner } from "./components/OfflineBanner";
import ErrorBoundary from "./components/ErrorBoundary";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ProfilePage from "./pages/ProfilePage";
import AcceptInvitationPage from "./pages/AcceptInvitationPage";
import AdminDashboard from "./pages/AdminDashboard";
import PromoterDashboard from "./pages/PromoterDashboard";
// El escáner carga html5-qrcode (~300 KB) y la boleta pública es una página
// aparte: chunks separados que solo baja quien los usa. El resto de roles
// nunca paga ese costo.
const BouncerScanner = lazy(() => import("./pages/BouncerScanner"));
const PublicTicketPage = lazy(() => import("./pages/PublicTicketPage"));
import Layout from "./components/Layout";
import { SplashScreen } from "./components/SplashScreen";

function RequireRole({ role, children }) {
  const { user, loading } = useAuth();
  // Splash de marca mientras se restaura la sesión (nunca un flash de login).
  if (loading) return <SplashScreen />;
  if (!user) return <Navigate to="/login" replace />;
  // roles: {"<venue_id>": ["admin", ...]}; si tiene rol en alguna venue, pasa
  const hasAny = Object.values(user.roles || {}).flat().includes(role);
  if (!hasAny) return <Navigate to="/login" replace />;
  return children;
}

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <SplashScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function App() {
  return (
    <AuthProvider>
      <UIProvider>
        <OfflineBanner />
        <BrowserRouter>
          <Suspense fallback={<SplashScreen />}>
          <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route
            path="/perfil"
            element={
              <RequireAuth>
                <Layout>
                  <ProfilePage />
                </Layout>
              </RequireAuth>
            }
          />
          {/* Boleta del invitado: publica, sin login. El token llega en el
              fragmento (#), que el navegador no envia al servidor. */}
          <Route path="/t" element={<PublicTicketPage />} />
          <Route path="/invitacion" element={<AcceptInvitationPage />} />
          <Route
            path="/admin"
            element={
              <RequireRole role="admin">
                <Layout>
                  <AdminDashboard />
                </Layout>
              </RequireRole>
            }
          />
          <Route
            path="/promotor"
            element={
              <RequireRole role="promotor">
                <Layout>
                  <PromoterDashboard />
                </Layout>
              </RequireRole>
            }
          />
          <Route
            path="/bouncer"
            element={
              <RequireRole role="bouncer">
                <BouncerScanner />
              </RequireRole>
            }
          />
          <Route path="/" element={<HomeRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
      </UIProvider>
    </AuthProvider>
  );
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <SplashScreen />;
  if (!user) return <Navigate to="/login" replace />;
  const roles = Object.values(user.roles || {}).flat();
  if (roles.includes("admin")) return <Navigate to="/admin" replace />;
  if (roles.includes("promotor")) return <Navigate to="/promotor" replace />;
  if (roles.includes("bouncer")) return <Navigate to="/bouncer" replace />;
  return <Navigate to="/login" replace />;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);