import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const roles = Object.values(user?.roles || {}).flat();
  const venueNames = (user?.venues || []).map((v) => v.name).join(", ");

  const tabs = [];
  if (roles.includes("admin")) tabs.push({ to: "/admin", label: "Admin" });
  if (roles.includes("promotor")) tabs.push({ to: "/promotor", label: "Promotor" });
  if (roles.includes("bouncer")) tabs.push({ to: "/bouncer", label: "Puerta" });

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <Link to="/" className="text-lg font-black text-white">
              Ticket<span className="text-indigo-400">Flow</span>
            </Link>
            <nav className="flex gap-1">
              {tabs.map((t) => (
                <Link
                  key={t.to}
                  to={t.to}
                  className="rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                >
                  {t.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-slate-400 sm:block">{user?.full_name}</span>
            <span className="hidden text-xs text-slate-500 md:block">{venueNames}</span>
            <button
              onClick={() => {
                logout();
                nav("/login");
              }}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              Salir
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}