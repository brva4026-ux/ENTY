import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Logo } from "./Brand";

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const roles = Object.values(user?.roles || {}).flat();
  const venueNames = (user?.venues || []).map((v) => v.name).join(", ");

  const tabs = [];
  if (roles.includes("admin")) tabs.push({ to: "/admin", label: "Admin" });
  if (roles.includes("promotor")) tabs.push({ to: "/promotor", label: "Promotor" });
  if (roles.includes("bouncer")) tabs.push({ to: "/bouncer", label: "Puerta" });

  const initials = (user?.full_name || "?")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="relative min-h-screen bg-slate-950">
      <div className="atmosphere" aria-hidden="true" />
      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-5">
            <Link to="/" aria-label="Inicio">
              <Logo />
            </Link>
            <nav className="flex gap-1">
              {tabs.map((t) => {
                const active = pathname === t.to;
                return (
                  <Link
                    key={t.to}
                    to={t.to}
                    className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                      active
                        ? "bg-brand-600/20 text-brand-300 ring-1 ring-brand-500/40"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    {t.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-3 text-sm">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-semibold leading-tight text-white">{user?.full_name}</p>
              {venueNames && <p className="text-xs leading-tight text-slate-500">{venueNames}</p>}
            </div>
            <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-accent-500 text-xs font-black text-white">
              {initials}
            </span>
            <button
              onClick={() => {
                logout();
                nav("/login");
              }}
              className="btn-ghost !px-3 !py-1.5 text-xs"
            >
              Salir
            </button>
          </div>
        </div>
      </header>
      <main className="relative z-10 mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
