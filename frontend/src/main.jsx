import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./index.css";
// Sentry primero de todo (no-op sin VITE_SENTRY_DSN): los crashes que ocurran
// durante el arranque también se reportan.
import { initFrontendSentry, captureError } from "./lib/sentry";
initFrontendSentry();
import { AuthProvider, useAuth } from "./lib/auth";
import { UIProvider } from "./lib/ui";
import { OfflineBanner } from "./components/OfflineBanner";
import ErrorBoundary from "./components/ErrorBoundary";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
// Code-splitting: TODAS las páginas de rol y flujos pesados son chunks
// separados que solo baja quien los usa. El admin no paga el escáner, el
// portero no paga el panel admin, y el invitado (el teléfono más humilde de
// todos) baja solo su boleta. Si un chunk falla al cargar (deploy nuevo +
// chunk viejo en caché, red flaca), se reporta y ofrece recargar.
const lazyPage = (loader) => {
  const Component = lazy(loader);
  return (props) => (
    <Suspense fallback={<SplashScreen />}>
      <ErrorBoundary onError={(e) => captureError(e, { kind: "chunk_error" })}>
        <Component {...props} />
      </ErrorBoundary>
    </Suspense>
  );
};
const AdminDashboard = lazyPage(() => import("./pages/AdminDashboard"));
const PromoterDashboard = lazyPage(() => import("./pages/PromoterDashboard"));
const BouncerScanner = lazyPage(() => import("./pages/BouncerScanner"));
const ProfilePage = lazyPage(() => import("./pages/ProfilePage"));
const PublicTicketPage = lazyPage(() => import("./pages/PublicTicketPage"));
const AcceptInvitationPage = lazyPage(() => import("./pages/AcceptInvitationPage"));
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