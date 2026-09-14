import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../lib/auth";
import { Logo } from "../components/Brand";

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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 p-4">
      {/* Auras de marca */}
      <div aria-hidden className="pointer-events-none absolute -top-32 left-1/2 h-96 w-[36rem] -translate-x-1/2 rounded-full bg-brand-600/20 blur-[110px]" />
      <div aria-hidden className="pointer-events-none absolute -bottom-40 -right-20 h-96 w-96 rounded-full bg-accent-500/10 blur-[110px]" />

      <div className="relative w-full max-w-sm animate-rise">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size="lg" />
          <p className="mt-2 text-sm text-slate-400">
            Boletería, cupos y puerta — en una sola app
          </p>
        </div>

        <form onSubmit={submit} className="card p-6">
          <h2 className="mb-4 text-lg font-bold text-white">Ingresar</h2>

          <label className="mb-1.5 block text-xs font-medium text-slate-400">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@bar.test"
            className="field mb-4"
            autoComplete="email"
          />

          <label className="mb-1.5 block text-xs font-medium text-slate-400">Contraseña</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="field mb-4"
            autoComplete="current-password"
          />

          {error && (
            <div className="mb-4 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? "Entrando…" : "Entrar"}
          </button>
        </form>

        <p className="mt-5 text-center text-xs leading-relaxed text-slate-500">
          Demo: admin@bar.test · promo1@bar.test · puerta@bar.test
          <br />
          contraseña <span className="font-mono text-slate-400">demo1234</span>
        </p>
      </div>
    </div>
  );
}
