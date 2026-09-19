import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { haptics } from "../lib/haptics";
import { Logo } from "./Brand";
import NotificationBell from "./NotificationBell";

/** Iconos de pestaña (trazo 1.8, 20px): mismo lenguaje visual en toda la app. */
const TAB_ICONS = {
  admin: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[22px] w-[22px]">
      <path d="M3 9.5 12 3l9 6.5V21H3V9.5z" />
      <path d="M9 21v-6h6v6" />
    </svg>
  ),
  promotor: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[22px] w-[22px]">
      <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.2a2.8 2.8 0 0 0 0 5.6V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.2a2.8 2.8 0 0 0 0-5.6V7z" />
    </svg>
  ),
  bouncer: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[22px] w-[22px]">
      <path d="M3 11v3a1 1 0 0 0 1 1h2l3.5 3.5a1 1 0 0 0 1.5-.8V6.3a1 1 0 0 0-1.5-.8L6 9H4a1 1 0 0 0-1 1z" />
      <path d="M16 9a5 5 0 0 1 0 6M18.5 6.5a8.5 8.5 0 0 1 0 11" />
    </svg>
  ),
};

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const roles = Object.values(user?.roles || {}).flat();
  const venueNames = (user?.venues || []).map((v) => v.name).join(", ");
  // El rol más alto define cómo se presenta la persona en el header.
  const roleLabel = roles.includes("admin")
    ? "Administrador"
    : roles.includes("promotor")
      ? "Promotor"
      : roles.includes("bouncer")
        ? "Portero"
        : "";

  const tabs = [];
  if (roles.includes("admin")) tabs.push({ to: "/admin", label: "Admin", icon: TAB_ICONS.admin });
  if (roles.includes("promotor")) tabs.push({ to: "/promotor", label: "Promotor", icon: TAB_ICONS.promotor });
  if (roles.includes("bouncer")) tabs.push({ to: "/bouncer", label: "Puerta", icon: TAB_ICONS.bouncer });

  const initials = (user?.full_name || "?")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="min-h-screen">
      {/* Header compacto: se reduce la marca y el nav se esconde en móvil
          (lo reemplaza la barra inferior, el patrón de apps nativas). */}
      <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-6">
            <Link to="/" aria-label="Inicio">
              <Logo />
            </Link>
            <nav className="hidden items-center gap-0.5 md:flex">
              {tabs.map((t) => {
                const active = pathname === t.to;
                return (
                  <Link
                    key={t.to}
                    to={t.to}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                      active
                        ? "bg-zinc-800 text-white"
                        : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                    }`}
                  >
                    {t.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-3 text-sm">
            <NotificationBell />
            <div className="hidden text-right sm:block">
              <p className="text-[13px] font-medium leading-tight text-zinc-200">{user?.full_name}</p>
              <p className="text-[11px] leading-tight text-zinc-500">
                {roleLabel}
                {venueNames && ` · ${venueNames}`}
              </p>
            </div>
            <Link
              to="/perfil"
              title="Tu perfil"
              aria-label="Tu perfil"
              className="grid h-7 w-7 place-items-center rounded-full bg-zinc-800 text-[11px] font-semibold text-zinc-300 ring-1 ring-zinc-700 transition hover:ring-brand-500"
            >
              {initials}
            </Link>
            <button
              onClick={() => {
                logout();
                nav("/login");
              }}
              className="btn-ghost !px-2.5 !py-1.5 text-xs"
            >
              Salir
            </button>
          </div>
        </div>
      </header>

      {/* pb extra en móvil: la barra inferior es fija y no debe tapar contenido.
          Cada navegación re-monta contenido → .reveal coreografía la entrada. */}
      <main className="mx-auto max-w-5xl px-4 py-6 pb-28 md:pb-8">
        <div key={pathname} className="reveal">
          {children}
        </div>
      </main>

      {/* Barra de pestañas inferior (solo móvil): iconos + etiqueta, indicador
          que aparece con pop, haptic al tocar — patrón iOS/Android. */}
      {tabs.length > 0 && (
        <nav
          className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur md:hidden"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          aria-label="Navegación principal"
        >
          <div className="mx-auto flex max-w-md items-stretch justify-around px-2 py-1.5">
            {tabs.map((t) => {
              const active = pathname === t.to;
              return (
                <Link
                  key={t.to}
                  to={t.to}
                  aria-current={active ? "page" : undefined}
                  onClick={() => haptics.tick()}
                  className={`flex flex-1 flex-col items-center gap-1 rounded-lg px-3 py-1.5 text-[11px] font-semibold transition ${
                    active ? "text-white" : "text-zinc-500 active:bg-zinc-900"
                  }`}
                >
                  <span className={`transition-transform duration-200 ${active ? "scale-110" : "scale-100"}`}>
                    {t.icon}
                  </span>
                  {t.label}
                  <span className={`h-0.5 w-5 rounded-full transition-all duration-300 ${active ? "bg-brand-400" : "bg-transparent"}`} />
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}
