import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
// Tokens PRIMERO: la fuente única de color/forma/movimiento. Las hojas de
// abajo consumen var(--e-*); ninguna inventa un hex de marca (stylelint lo
// vigila). Ver docs/estetica-plan.md (Fase 1).
import "./tokens.css";
import "./index.css";
import "./aesthetic-refresh.css";
import "./enty-system.css";
// Voz de OPERACIÓN del panel (tiras de cifras, medidores, cola de puerta y
// tabla de promotores). Va al final: es la capa más específica del panel y
// consume los tokens de las anteriores. La vitrina del fan no la usa.
import "./panel-cockpit.css";
// Capa de experiencia del fan (vitrina editorial responsive): se importa al
// final para llevar la marca a su forma definitiva sin reescribir el sistema.
import "./enty-fan.css";
// Sentry primero de todo (no-op sin VITE_SENTRY_DSN): los crashes que ocurran
// durante el arranque también se reportan.
import { initFrontendSentry, captureError } from "./lib/sentry";
initFrontendSentry();
// Tema ANTES del primer render: cero flash (el html ya trae su script inline
// anti-flash; esto re-aplica y deja el listener del sistema listo).
import { initTheme } from "./lib/theme";
initTheme();
// Movimiento ANTES del primer render, por el mismo motivo que el tema: la
// primera animación del hero ya sale apagada si la persona pidió quietud.
import { applyMotion } from "./lib/motion";
applyMotion();
import { AuthProvider, useAuth, consumeLoggedOut } from "./lib/auth";
import { UIProvider } from "./lib/ui";
import { hasRole, homeForRole } from "./lib/roles";
import { OfflineBanner } from "./components/OfflineBanner";
import ErrorBoundary from "./components/ErrorBoundary";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import NotFoundPage from "./pages/NotFoundPage";
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
const FunnelPage = lazyPage(() => import("./pages/FunnelPage"));
const BouncerScanner = lazyPage(() => import("./pages/BouncerScanner"));
const ProfilePage = lazyPage(() => import("./pages/ProfilePage"));
const PublicTicketPage = lazyPage(() => import("./pages/PublicTicketPage"));
const HomePage = lazyPage(() => import("./pages/HomePage"));
const EventDetailPage = lazyPage(() => import("./pages/EventDetailPage"));
const MyTicketsPage = lazyPage(() => import("./pages/MyTicketsPage"));
const WaitlistPage = lazyPage(() => import("./pages/WaitlistPage"));
const AcceptInvitationPage = lazyPage(
  () => import("./pages/AcceptInvitationPage"),
);
const ResetPasswordPage = lazyPage(() => import("./pages/ResetPasswordPage"));
const DoorLinkPage = lazyPage(() => import("./pages/DoorLinkPage"));
// Documentos legales: públicos y compartibles (un abogado, un aliado o el
// propio usuario pueden abrirlos sin sesión). El texto lo sirve la API desde
// backend/app/assets/legal/*.md, que es la MISMA copia que la base versiona:
// si el texto viviera también en el bundle, la persona aceptaría una versión
// distinta de la que legal_documents considera vigente.
const LegalPage = lazyPage(() => import("./pages/LegalPage"));
import Layout from "./components/Layout";
import { CookieNotice } from "./components/CookieNotice";
import { SplashScreen } from "./components/SplashScreen";

function RequireRole({ role, children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  // Splash de marca mientras se restaura la sesión (nunca un flash de login).
  if (loading) return <SplashScreen />;
  // "from" viaja en location.state: el login lo lee y aterriza donde el
  // usuario iba, no en su dashboard por defecto. EXCEPCIÓN: un logout
  // intencional (bandera de lib/auth) redirige sin state — si el guard
  // re-renderiza con user=null antes de que la URL cambie, sembraría
  // from=ruta-actual y el siguiente login no aterrizaría en el panel del rol.
  if (!user)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: consumeLoggedOut() ? undefined : location.pathname }}
      />
    );
  // La fuente de verdad de la navegación es lib/roles.js; el backend re-
  // verifica en DB cada request (ensure_roles) — esto es UX, no cerradura.
  if (!hasRole(user, role)) return <Navigate to="/" replace />;
  return children;
}

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <SplashScreen />;
  if (!user)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: consumeLoggedOut() ? undefined : location.pathname }}
      />
    );
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
              {/* Reset self-service: pública, el token del correo es la credencial
              de un solo uso; la página lo canjea por la nueva contraseña. */}
              <Route path="/reset" element={<ResetPasswordPage />} />
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
              {/* Inicio: la vitrina publica del fan (catalogo de eventos).
              Sin login — es la cara de consumidor de Enty. */}
              <Route path="/inicio" element={<HomePage />} />
              {/* Detalle del evento: la pantalla de compra, publica como la
              vitrina. Se llega tocando un evento del catalogo. */}
              <Route path="/evento/:id" element={<EventDetailPage />} />
              <Route path="/boletas" element={<MyTicketsPage />} />
              {/* Legales: públicas, sin login. Cierran el bloqueante de operar
              con cobros reales (no había dónde asentar términos ni privacidad).
              La URL de cada una coincide con legal_documents.url en la base. */}
              <Route
                path="/terminos"
                element={<LegalPage slug="terminos-plataforma" />}
              />
              <Route
                path="/terminos-boleta"
                element={<LegalPage slug="terminos-boleta" />}
              />
              <Route
                path="/privacidad"
                element={<LegalPage slug="privacidad" />}
              />
              <Route path="/cookies" element={<LegalPage slug="cookies" />} />
              <Route
                path="/encargo-datos"
                element={<LegalPage slug="encargo-datos" />}
              />
              {/* Lista de espera (E2): publica, sin cuentas. La credencial del
              fan tambien viaja en el fragmento y se guarda en localStorage. */}
              <Route path="/waitlist" element={<WaitlistPage />} />
              <Route path="/invitacion" element={<AcceptInvitationPage />} />
              {/* Link de puerta con la NOCHE YA FIJA (mig 025): lo abre quien
              el admin asigno a ese evento. El canje atada la persona a esa
              noche y manda al escaner sin selector. */}
              <Route path="/puerta" element={<DoorLinkPage />} />
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
                path="/admin/metricas"
                element={
                  <RequireRole role="admin">
                    <Layout>
                      <FunnelPage />
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
              {/* Ruta inexistente: pantalla propia, no redirección muda a "/".
                  Un enlace roto o un QR viejo se veían como un aterrizaje
                  normal, sin explicar que la dirección pedida no existe. */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
          {/* Aviso de cookies: necesita router hooks (navega a /cookies), por
              eso vive DENTRO de BrowserRouter y no junto a OfflineBanner. */}
          <CookieNotice />
        </BrowserRouter>
      </UIProvider>
    </AuthProvider>
  );
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <SplashScreen />;
  // La raíz es la VITRINA, no el login: Enty vende boletas al fan y la
  // mayoría de quien abre un enlace compartido no tiene cuenta. Mandarlo a
  // /login lo dejaba sin catálogo y sin forma de volver. El staff no pierde
  // entrada: "Acceso" en la cabecera y "Perfil" en la barra inferior.
  if (!user) return <Navigate to="/inicio" replace />;
  return <Navigate to={homeForRole(user)} replace />;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
