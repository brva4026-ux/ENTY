import { createContext, useContext, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import TransitionLink from "./TransitionLink";
import Icon from "./Icon";
import NotificationBell from "./NotificationBell";
import ThemeToggle from "./ThemeToggle";
import { Logo } from "./Brand";
import { useAuth } from "../lib/auth";
import { useUI } from "../lib/ui";
import { haptics } from "../lib/haptics";
import { initials } from "../lib/initials";
import { activeVenueId, setActiveVenueId } from "../lib/venue";
import { apiFetch } from "../lib/api";
import { roleIdentity } from "../lib/roles";

const AdminChromeContext = createContext({ setBreadcrumb: () => {} });

/** Permite que una página (p. ej. el Backstage) escriba el nombre del evento
 *  en la franja superior sin acoplar AdminShell a los datos del evento. */
export function useAdminChrome() {
  return useContext(AdminChromeContext);
}

const ADMIN_TABS = [
  { to: "/admin", label: "Eventos", icon: "calendar" },
  { to: "/admin/reportes", label: "Reportes", icon: "chart" },
  { to: "/admin/organizacion", label: "Organización", icon: "users" },
];

function isActive(pathname, to) {
  if (to === "/admin") return pathname === "/admin";
  return pathname === to || pathname.startsWith(`${to}/`);
}

export default function AdminShell({ children }) {
  const { user, logout, setUser } = useAuth();
  const { pathname } = useLocation();
  const nav = useNavigate();
  const ui = useUI();
  const [switching, setSwitching] = useState(false);
  const [breadcrumb, setBreadcrumb] = useState("");
  const adminIdentity = roleIdentity("admin");

  const venueId = activeVenueId(user);
  const venue = (user?.venues || []).find((v) => v.id === venueId);
  const adminVenueIds = Object.entries(user?.roles || {})
    .filter(([, roles]) => roles.some((r) => r === "admin" || r === "super_admin"))
    .map(([id]) => Number(id));
  const adminVenues = (user?.venues || []).filter((v) =>
    adminVenueIds.includes(v.id),
  );

  async function switchVenue(nextId) {
    if (!nextId || nextId === venueId || switching) return;
    setSwitching(true);
    try {
      const updated = await apiFetch("/auth/me/active-venue", {
        method: "PUT",
        body: JSON.stringify({ venue_id: Number(nextId) }),
      });
      setActiveVenueId(Number(nextId));
      setUser(updated);
      haptics.tick();
      // La ruta se mantiene; las páginas dependen de activeVenueId(user) y
      // vuelven a pedir eventos, reportes, equipo y avisos de esa org.
      nav(pathname, { replace: true });
    } catch (err) {
      ui.error(err.message || "No pudimos cambiar de organización.");
    } finally {
      setSwitching(false);
    }
  }

  const pageLabel =
    ADMIN_TABS.find((t) => isActive(pathname, t.to))?.label ?? "Eventos";

  return (
    <AdminChromeContext.Provider value={{ setBreadcrumb }}>
    <div className="admin-shell" data-role-accent={adminIdentity.accent}>
      <a href="#contenido-admin" className="skip-link">
        Saltar al contenido
      </a>

      <aside className="admin-sidebar" aria-label="Navegación de Administración">
        <TransitionLink
          to="/admin"
          className="admin-sidebar-brand"
          aria-label="Enty · Eventos"
        >
          <Logo />
        </TransitionLink>
        <p className="admin-sidebar-kicker">Administración</p>
        <nav className="admin-nav">
          {ADMIN_TABS.map((t) => (
            <TransitionLink
              key={t.to}
              to={t.to}
              aria-current={isActive(pathname, t.to) ? "page" : undefined}
              className={`admin-nav-link${isActive(pathname, t.to) ? " is-active" : ""}`}
            >
              <Icon name={t.icon} aria-hidden="true" />
              {t.label}
            </TransitionLink>
          ))}
        </nav>
        <div className="admin-sidebar-foot">
          <span className="admin-sidebar-venue">
            <Icon name="users" className="h-3.5 w-3.5" aria-hidden="true" />
            {venue?.name ?? "Tu organización"}
          </span>
        </div>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <div className="admin-topbar-left">
            <TransitionLink
              to="/admin"
              className="admin-topbar-brand"
              aria-label="Enty · Eventos"
            >
              <Logo />
            </TransitionLink>
            <nav className="admin-crumbs" aria-label="Ubicación">
              <TransitionLink to="/admin" className="admin-crumb-home">
                {breadcrumb ? (
                  <>
                    <Icon name="back" className="h-3.5 w-3.5" aria-hidden="true" />
                    Eventos
                  </>
                ) : (
                  pageLabel
                )}
              </TransitionLink>
              {breadcrumb && (
                <>
                  <span className="admin-crumb-sep" aria-hidden="true">/</span>
                  <span className="admin-crumb-current" title={breadcrumb}>
                    {breadcrumb}
                  </span>
                </>
              )}
            </nav>
          </div>

          <div className="admin-topbar-actions">
            {adminVenues.length > 1 ? (
              <label className="admin-org-select">
                <span className="sr-only">Organización activa</span>
                <Icon name="users" className="h-3.5 w-3.5" aria-hidden="true" />
                <select
                  value={venueId ?? ""}
                  onChange={(e) => switchVenue(e.target.value)}
                  disabled={switching}
                  aria-label="Organización activa"
                >
                  {adminVenues.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="admin-org-name">
                <Icon name="users" className="h-3.5 w-3.5" aria-hidden="true" />
                {venue?.name ?? "Tu organización"}
              </span>
            )}
            <span
              className="admin-topbar-role"
              title={`Rol activo: ${adminIdentity.label}`}
              aria-label={`Rol activo: ${adminIdentity.label}`}
            >
              <Icon name={adminIdentity.icon} className="h-4 w-4" aria-hidden="true" />
              <span>{adminIdentity.label}</span>
            </span>
            <ThemeToggle />
            <NotificationBell />
            <TransitionLink
              to="/perfil"
              aria-label="Tu perfil"
              data-tip="Tu perfil"
              className="admin-avatar"
            >
              {initials(user?.full_name)}
            </TransitionLink>
            <button
              type="button"
              className="admin-logout"
              aria-label="Cerrar sesión"
              data-tip="Cerrar sesión"
              onClick={async () => {
                try {
                  await logout();
                  nav("/login", { replace: true });
                } catch {
                  ui.toast(
                    "No pudimos cerrar la sesión. Intenta de nuevo.",
                    "error",
                  );
                }
              }}
            >
              <Icon name="logout" className="h-4 w-4" />
            </button>
          </div>
        </header>

        <main id="contenido-admin" className="admin-content">
          <div key={`${venueId}-${pathname}`} className="reveal">
            {children}
          </div>
        </main>
      </div>

      <nav className="admin-bottomnav" aria-label="Navegación principal">
        <div className="admin-bottomnav-inner">
          {ADMIN_TABS.map((t) => (
            <TransitionLink
              key={t.to}
              to={t.to}
              aria-current={isActive(pathname, t.to) ? "page" : undefined}
              onClick={() => haptics.tick()}
              className={isActive(pathname, t.to) ? "is-active" : ""}
            >
              <Icon name={t.icon} aria-hidden="true" />
              {t.label}
            </TransitionLink>
          ))}
        </div>
      </nav>
    </div>
    </AdminChromeContext.Provider>
  );
}
