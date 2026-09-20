import { useNavigate } from "react-router-dom";
import { useMemo, useState } from "react";
import { useAuth } from "../lib/auth";
import { missingList } from "../lib/passwordPolicy";
import { Logo } from "../components/Brand";
import PasswordMeter from "../components/PasswordMeter";

const STRENGTH = [
  { max: 2, label: "Débil", color: "bg-red-500", width: "w-1/4" },
  { max: 3, label: "Aceptable", color: "bg-amber-500", width: "w-2/4" },
  { max: 4, label: "Buena", color: "bg-emerald-500", width: "w-3/4" },
  { max: 99, label: "Excelente", color: "bg-emerald-400", width: "w-full" },
];

export default function RegisterPage() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({
    venue_name: "",
    full_name: "",
    email: "",
    password: "",
  });
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Misma política que el backend (lib compartida): el submit no pasa con
  // requisitos pendientes y la checklist en vivo explica cuáles.
  const issues = useMemo(() => missingList(form.password), [form.password]);
  const score = 4 - issues.length;
  const strength = STRENGTH.find((s) => score <= s.max) ?? STRENGTH[3];

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e) {
    e.preventDefault();
    if (issues.length > 0) {
      setError(`A la contraseña le falta: ${issues.join(", ")}.`);
      return;
    }
    setError("");
    setBusy(true);
    try {
      await register(form);
      nav("/admin");
    } catch (err) {
      const raw = (err?.message || "").toLowerCase();
      if (err?.status === 409 || raw.includes("ya tiene una cuenta")) {
        setError("Ese correo ya está registrado. Inicia sesión en su lugar.");
      } else if (raw.includes("demasiados") || err?.status === 429) {
        setError("Demasiados intentos. Espera unos minutos.");
      } else {
        setError(
          err?.message || "No pudimos crear tu cuenta. Inténtalo de nuevo.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const filled = Object.values(form).filter((v) => v.trim()).length;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      {/* Mismos halos de marca que el login: una sola experiencia de entrada */}
      <div
        className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-brand-600/25 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-40 -right-24 h-96 w-96 rounded-full bg-sky-500/15 blur-3xl"
        aria-hidden="true"
      />

      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size="xl" />
          <p className="mt-4 text-sm font-medium text-zinc-400">
            Crea el panel de tu negocio en un minuto
          </p>
        </div>

        <div className="auth-card card-interactive reveal p-6 sm:p-7">
          <h1 className="display mb-1 text-lg">Crea tu cuenta</h1>
          <p className="eyebrow mb-5">Tu negocio, bajo tu control</p>

          <form onSubmit={submit}>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              Nombre de tu negocio
            </label>
            <input
              value={form.venue_name}
              onChange={(e) => set("venue_name", e.target.value)}
              placeholder="Bar La Esquina"
              className="field mb-4"
              maxLength={120}
              required
            />

            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              Tu nombre completo
            </label>
            <input
              value={form.full_name}
              onChange={(e) => set("full_name", e.target.value)}
              placeholder="Ana Gómez"
              className="field mb-4"
              maxLength={120}
              required
            />

            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              Correo
            </label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              placeholder="tu@negocio.com"
              className="field mb-4"
              autoComplete="email"
              required
            />

            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              Contraseña
            </label>
            <div className="relative mb-2">
              <input
                type={showPass ? "text" : "password"}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder="Mínimo 8 caracteres"
                className="field mb-0 !pr-12"
                autoComplete="new-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-100"
                aria-label={
                  showPass ? "Ocultar contraseña" : "Mostrar contraseña"
                }
                aria-pressed={showPass}
              >
                {/* Ojo con icono (mismo lenguaje visual del sistema) */}
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-5 w-5"
                  aria-hidden="true"
                >
                  <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
                  <circle cx="12" cy="12" r="3.2" />
                  {!showPass && <path d="M4.5 19.5 19.5 4.5" />}
                </svg>
              </button>
            </div>

            {form.password && (
              <div className="mb-4">
                <div className="flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={`h-full ${strength.color} ${strength.width} transition-all`}
                    />
                  </div>
                  <span className="text-[11px] font-semibold text-zinc-400">
                    {strength.label}
                  </span>
                </div>
                <PasswordMeter value={form.password} />
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

            <button
              type="submit"
              disabled={busy || issues.length > 0}
              className="btn-primary w-full"
            >
              {busy && (
                <svg
                  className="btn-spinner"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )}
              {busy ? "Creando tu panel…" : "Crear mi panel"}
            </button>

            <p className="mt-3 text-center text-xs leading-relaxed text-zinc-500">
              {filled < 4
                ? "Serás el administrador: podrás invitar a tu equipo después."
                : "Todo listo: al crear entrarás directo como administrador."}
            </p>
          </form>
        </div>

        <p className="mt-5 text-center text-sm text-zinc-400">
          ¿Ya tienes cuenta?{" "}
          <button
            onClick={() => nav("/login")}
            className="font-semibold text-brand-300 transition hover:text-brand-200"
          >
            Ingresar
          </button>
        </p>
      </div>
    </div>
  );
}
