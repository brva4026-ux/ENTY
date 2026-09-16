import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./index.css";
import { AuthProvider, useAuth } from "./lib/auth";
import { apiFetch } from "./lib/api";
import ErrorBoundary from "./components/ErrorBoundary";
import LoginPage from "./pages/LoginPage";
import AdminDashboard from "./pages/AdminDashboard";
import PromoterDashboard from "./pages/PromoterDashboard";
import BouncerScanner from "./pages/BouncerScanner";
import PublicTicketPage from "./pages/PublicTicketPage";
import Layout from "./components/Layout";

function RequireRole({ role, children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        Cargando…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  // roles: {"<venue_id>": ["admin", ...]}; si tiene rol en alguna venue, pasa
  const hasAny = Object.values(user.roles || {}).flat().includes(role);
  if (!hasAny) return <Navigate to="/login" replace />;
  return children;
}

function App() {
  // exDevel: puente para probar la API sin tocar el backend proxy de Vite
  window.__apiFetch = apiFetch;
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          {/* Boleta del invitado: publica, sin login. El token llega en el
              fragmento (#), que el navegador no envia al servidor. */}
          <Route path="/t" element={<PublicTicketPage />} />
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
      </BrowserRouter>
    </AuthProvider>
  );
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) return null;
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