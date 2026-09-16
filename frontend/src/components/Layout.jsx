import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Logo } from "./Brand";
import Icon from "./Icon";

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const roles = Object.values(user?.roles || {}).flat();
  const venueNames = (user?.venues || []).map((v) => v.name).join(", ");

  const tabs = [];
  if (roles.includes("admin")) tabs.push({ to: "/admin", label: "Admin", icon: "chart" });
  if (roles.includes("promotor")) tabs.push({ to: "/promotor", label: "Promotor", icon: "ticket" });
  if (roles.includes("bouncer")) tabs.push({ to: "/bouncer", label: "Puerta", icon: "door" });

  const initials = (user?.full_name || "?")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="grain relative min-h-screen bg-slate-950">
      <div className="atmosphere" aria-hidden="true" />
      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-4">
            <Link to="/" aria-label="Inicio" className="shrink-0">
              <Logo />
            </Link>
            <nav className="flex gap-1" aria-label="Secciones">
              {tabs.map((t) => {
                const active = pathname === t.to;
                return (
                  <Link
                    key={t.to}
                    to={t.to}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                      active
                        ? "bg-brand-600/20 text-brand-300 ring-1 ring-brand-500/40"
                        : "text-slate-400 hover:bg-slate-800/70 hover:text-white"
                    }`}
                  >
                    <Icon name={t.icon} className="h-4 w-4" />
                    {t.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-2.5 text-sm">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-semibold leading-tight text-white">{user?.full_name}</p>
              {venueNames && <p className="text-xs leading-tight text-slate-500">{venueNames}</p>}
            </div>
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-accent-500 text-xs font-black text-white ring-1 ring-white/10">
              {initials}
            </span>
            <button
              onClick={() => {
                logout();
                nav("/login");
              }}
              aria-label="Salir"
              className="btn-ghost tap-target !px-2.5"
            >
              <Icon name="logout" className="h-4 w-4" />
              <span className="hidden sm:inline">Salir</span>
            </button>
          </div>
        </div>
      </header>
      <main className="relative z-10 mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
