import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../lib/auth";

export default function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const user = await login(email, password);
      const roles = Object.values(user.roles || {}).flat();
      if (roles.includes("admin")) nav("/admin");
      else if (roles.includes("promotor")) nav("/promotor");
      else if (roles.includes("bouncer")) nav("/bouncer");
      else setError("Tu usuario no tiene un rol asignado");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black tracking-tight text-white">
            Ticket<span className="text-indigo-400">Flow</span>
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Boletería y control de aforo
          </p>
        </div>

        <form onSubmit={submit} className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
          <h2 className="mb-4 text-lg font-semibold text-white">Ingresar</h2>
          <label className="mb-1.5 block text-xs font-medium text-slate-400">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@bar.test"
            className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 outline-none focus:border-indigo-400"
            autoComplete="email"
          />
          <label className="mb-1.5 block text-xs font-medium text-slate-400">Contraseña</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="demo1234"
            className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 outline-none focus:border-indigo-400"
            autoComplete="current-password"
          />

          {error && (
            <div className="mb-4 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-indigo-500 py-2.5 font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
          >
            {busy ? "Entrando…" : "Entrar"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-500">
          Demo: admin@bar.test · promo1@bar.test · puerta@bar.test · pass{" "}
          <span className="font-mono text-slate-400">demo1234</span>
        </p>
      </div>
    </div>
  );
}