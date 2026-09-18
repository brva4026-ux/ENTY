import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import { Logo } from "../components/Brand";

/** Traduce errores técnicos del backend a mensajes que una persona entiende
 *  y sabe qué hacer después. */
function loginErrorMessage(err) {
  const raw = err?.message || "";
  if (err?.status === 401) {
    if (raw.toLowerCase().includes("inactivo")) {
      return "Tu cuenta está desactivada. Pide a un administrador de tu negocio que la reactive.";
    }
    return "Correo o contraseña incorrectos. Revisa mayúsculas y vuelve a intentar.";
  }
  if (err?.status === 429) {
    return "Demasiados intentos fallidos. Espera unos minutos y prueba de nuevo.";
  }
  if (err?.status === 422) {
    return "Revisa el formato del correo e inténtalo de nuevo.";
  }
  if (raw.toLowerCase().includes("failed to fetch") || raw.toLowerCase().includes("network")) {
    return "No hay conexión con el servidor. Verifica tu internet.";
  }
  return raw || "No pudimos iniciar sesión. Inténtalo de nuevo.";
}

export default function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Recuperación de contraseña
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotMsg, setForgotMsg] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);

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
      setError(loginErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitForgot(e) {
    e.preventDefault();
    setForgotBusy(true);
    setForgotMsg("");
    try {
      const res = await apiFetch("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setForgotMsg(res.detail);
    } catch (err) {
      setForgotMsg(
        "No pudimos procesar la solicitud ahora. Inténtalo en unos minutos."
      );
    } finally {
      setForgotBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size="lg" />
          <p className="mt-3 text-sm text-zinc-500">
            Boletería, cupos y puerta — en una sola app
          </p>
        </div>

        <div className="card card-interactive reveal p-6">
          <h1 className="display mb-1 text-lg">Ingresar</h1>
          <p className="eyebrow mb-5">Acceso del personal</p>

          <form onSubmit={submit}>
            <label
              htmlFor="login-email"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Correo
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@negocio.com"
              className="field mb-4"
              autoComplete="email"
              autoFocus
              required
            />

            <label
              htmlFor="login-password"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Contraseña
            </label>
            <div className="relative mb-2">
              <input
                id="login-password"
                type={showPass ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Tu contraseña"
                className="field mb-0 !pr-16"
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-semibold text-zinc-400 transition hover:text-zinc-200"
                aria-label={showPass ? "Ocultar contraseña" : "Mostrar contraseña"}
              >
                {showPass ? "Ocultar" : "Ver"}
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                setForgotOpen((v) => !v);
                setForgotMsg("");
              }}
              className="mb-4 text-xs font-medium text-brand-300 transition hover:text-brand-200"
            >
              ¿Olvidaste tu contraseña?
            </button>

            {forgotOpen && (
              <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="mb-2 text-xs leading-relaxed text-zinc-400">
                  Escribe el correo con el que entras y te decimos cómo
                  recuperar el acceso.
                </p>
                <button
                  type="button"
                  disabled={forgotBusy || !email}
                  onClick={submitForgot}
                  className="btn-ghost w-full text-xs font-bold disabled:opacity-40"
                >
                  {forgotBusy ? "Consultando…" : "Cómo recupero mi acceso"}
                </button>
                {forgotMsg && (
                  <p className="mt-2 text-xs leading-relaxed text-emerald-300">
                    {forgotMsg}
                  </p>
                )}
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm leading-relaxed text-red-300"
              >
                {error}
              </div>
            )}

            <button type="submit" disabled={busy} className="btn-primary w-full">
              {busy ? "Entrando…" : "Entrar"}
            </button>
          </form>
        </div>        <p className="mt-5 animate-fade text-center text-sm text-zinc-400">
          ¿Nuevo en TicketFlow? {" "}
          <button
            onClick={() => nav("/register")}
            className="link-underline font-semibold text-brand-300"
          >
            Crea tu negocio
          </button>
        </p>
      </div>
    </div>
  );
}
