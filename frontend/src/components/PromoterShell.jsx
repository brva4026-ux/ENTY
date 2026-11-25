import { useEffect, useRef, useState } from "react";
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
import { operationalRoles, roleIdentity } from "../lib/roles";
import useDocumentTitle from "../lib/useDocumentTitle";

const TABS = [
  { to: "/promotor", label: "Mis eventos", icon: "calendar" },
  { to: "/promotor/ventas", label: "Mis ventas", icon: "ticket" },
  { to: "/promotor/comisiones", label: "Comisiones", icon: "money" },
];

function isTabActive(pathname, to) {
  if (to === "/promotor") {
    return pathname === "/promotor" || pathname.startsWith("/promotor/evento/");
  }
  return pathname === to || pathname.startsWith(`${to}/`);
}

function pageTitle(pathname) {
  if (pathname.startsWith("/promotor/evento/")) return "Evento";
  if (pathname.startsWith("/promotor/ventas")) return "Mis ventas";
  if (pathname.startsWith("/promotor/comisiones")) return "Comisiones";
  return "Mis eventos";
}

export default function PromoterShell({ children }) {
  const { user, logout, setUser } = useAuth();
  const { pathname } = useLocation();
  useDocumentTitle(pageTitle(pathname));
  const nav = useNavigate();
  const ui = useUI();
  const [switching, setSwitching] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);
  const roleRef = useRef(null);
  const identity = roleIdentity("promotor");

  const venueId = activeVenueId(user);
  const venue = (user?.venues || []).find((v) => v.id === venueId);
  const promoterVenues = (user?.venues || []).filter((v) =>
    (user?.roles?.[String(v.id)] || []).includes("promotor"),
  );
  const roles = operationalRoles(user);
  const isEvent = pathname.startsWith("/promotor/evento/");

  useEffect(() => {
    if (!roleOpen) return;
    const close = (e) => {
      if (roleRef.current && !roleRef.current.contains(e.target)) setRoleOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [roleOpen]);

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
      nav("/promotor", { replace: true });
    } catch (err) {
      ui.error(err.message || "No pudimos cambiar de organización.");
    } finally {
      setSwitching(false);
    }
  }

  async function switchRole(role) {
    setRoleOpen(false);
    const home = roleIdentity(role).home;
    const wanted = role === "admin" ? ["admin", "super_admin"] : [role];
    const targetVenue = (user?.venues || []).find((v) =>
      (user?.roles?.[String(v.id)] || []).some((r) => wanted.includes(r)),
    );
    if (targetVenue && targetVenue.id !== venueId) {
      setSwitching(true);
      try {
        const updated = await apiFetch("/auth/me/active-venue", {
          method: "PUT",
          body: JSON.stringify({ venue_id: targetVenue.id }),
        });
        setActiveVenueId(targetVenue.id);
        setUser(updated);
      } catch (err) {
        ui.error(err.message || "No pudimos cambiar de organización.");
        return;
      } finally {
        setSwitching(false);
      }
    }
    if (home !== pathname) nav(home);
  }

  return (
    <div className="admin-shell promoter-shell" data-role-accent="promotor">
      <a href="#contenido-promotor" className="skip-link">
        Saltar al contenido
      </a>

      <aside className="admin-sidebar promoter-sidebar" aria-label="Navegación del promotor">
        <TransitionLink to="/promotor" className="admin-sidebar-brand" aria-label="Enty · Mis eventos">
          <Logo />
        </TransitionLink>
        <p className="admin-sidebar-kicker">Promotor</p>
        <nav className="admin-nav">
          {TABS.map((t) => (
            <TransitionLink
              key={t.to}
              to={t.to}
              aria-current={isTabActive(pathname, t.to) ? "page" : undefined}
              className={`admin-nav-link${isTabActive(pathname, t.to) ? " is-active" : ""}`}
            >
              <Icon name={t.icon} aria-hidden="true" />
              {t.label}
            </TransitionLink>
          ))}
        </nav>
        <div className="admin-sidebar-foot">
          <span className="promoter-sidebar-org">
            <Icon name="users" className="h-3.5 w-3.5" aria-hidden="true" />
            {venue?.name ?? "Tu organización"}
          </span>
          <span className="promoter-sidebar-role">
            <Icon name={identity.icon} className="h-3.5 w-3.5" aria-hidden="true" />
            {identity.label}
          </span>
        </div>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar promoter-topbar">
          <div className="admin-topbar-left">
            <TransitionLink to="/promotor" className="admin-topbar-brand" aria-label="Enty · Mis eventos">
              <Logo />
            </TransitionLink>
            <nav className="admin-crumbs" aria-label="Ubicación">
              {isEvent ? (
                <>
                  <TransitionLink to="/promotor" className="admin-crumb-home">
                    <Icon name="back" className="h-3.5 w-3.5" aria-hidden="true" />
                    Mis eventos
                  </TransitionLink>
                  <span className="admin-crumb-sep" aria-hidden="true">/</span>
                  <span className="admin-crumb-current">Evento</span>
                </>
              ) : (
                <span className="admin-crumb-home">{pageTitle(pathname)}</span>
              )}
            </nav>
          </div>

          <div className="admin-topbar-actions">
            {promoterVenues.length > 1 ? (
              <label className="admin-org-select promoter-org-select">
                <span className="sr-only">Organización activa</span>
                <Icon name="users" className="h-3.5 w-3.5" aria-hidden="true" />
                <select
                  value={venueId ?? ""}
                  onChange={(e) => switchVenue(e.target.value)}
                  disabled={switching}
                  aria-label="Organización activa"
                >
                  {promoterVenues.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="admin-org-name promoter-org-name">
                <Icon name="users" className="h-3.5 w-3.5" aria-hidden="true" />
                {venue?.name ?? "Tu organización"}
              </span>
            )}

            <div className="promoter-role-wrap" ref={roleRef}>
              <button
                type="button"
                className="admin-topbar-role promoter-role-chip"
                aria-haspopup={roles.length > 1 ? "menu" : undefined}
                aria-expanded={roles.length > 1 ? roleOpen : undefined}
                onClick={() => roles.length > 1 && setRoleOpen((v) => !v)}
                title={roles.length > 1 ? "Cambiar de rol" : "Rol activo: Promotor"}
              >
                <Icon name={identity.icon} className="h-4 w-4" aria-hidden="true" />
                <span>{identity.label}</span>
                {roles.length > 1 && <Icon name="chevronDown" className="h-3 w-3" aria-hidden="true" />}
              </button>
              {roleOpen && (
                <div className="promoter-role-menu" role="menu" aria-label="Cambiar de rol">
                  {roles.map((role) => {
                    const r = roleIdentity(role);
                    return (
                      <button
                        key={role}
                        type="button"
                        role="menuitem"
                        className={role === "promotor" ? "is-active" : ""}
                        onClick={() => switchRole(role)}
                      >
                        <Icon name={r.icon} className="h-4 w-4" aria-hidden="true" />
                        {r.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <ThemeToggle />
            <NotificationBell />
            <TransitionLink
              to="/perfil"
              aria-label="Tu perfil"
              data-tip="Tu perfil"
              className="admin-avatar promoter-avatar"
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
                  ui.toast("No pudimos cerrar la sesión. Intenta de nuevo.", "error");
                }
              }}
            >
              <Icon name="logout" className="h-4 w-4" />
            </button>
          </div>
        </header>

        <main id="contenido-promotor" className="admin-content promoter-content">
          <div key={`${venueId}-${pathname}`} className="reveal">
            {children}
          </div>
        </main>
      </div>

      <nav className="admin-bottomnav promoter-bottomnav" aria-label="Navegación principal">
        <div className="admin-bottomnav-inner">
          {TABS.map((t) => (
            <TransitionLink
              key={t.to}
              to={t.to}
              aria-current={isTabActive(pathname, t.to) ? "page" : undefined}
              onClick={() => haptics.tick()}
              className={isTabActive(pathname, t.to) ? "is-active" : ""}
            >
              <Icon name={t.icon} aria-hidden="true" />
              {t.label}
            </TransitionLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
