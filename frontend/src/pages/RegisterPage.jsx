import { useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../lib/auth";
// El registro siempre crea un admin de venue: el mismo criterio de redirect
// que el login (lib/roles.js), sin re-hacerlo a mano.
import { homeForRole } from "../lib/roles";
import { missingList } from "../lib/passwordPolicy";
import { fetchLegalDocuments } from "../lib/legal";
import PasswordMeter from "../components/PasswordMeter";
import { LockIcon, MailIcon } from "../components/AuthBackdrop";
import { AuthShell } from "../components/AuthShell";
import useDocumentTitle from "../lib/useDocumentTitle";

const STRENGTH = [
  { max: 2, label: "Débil", color: "bg-red-500", width: "w-1/4" },
  { max: 3, label: "Aceptable", color: "bg-amber-500", width: "w-2/4" },
  { max: 4, label: "Buena", color: "bg-emerald-500", width: "w-3/4" },
  { max: 99, label: "Excelente", color: "bg-emerald-400", width: "w-full" },
];

export default function RegisterPage() {
  useDocumentTitle("Crear cuenta");
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
  // Aceptación de los términos (mig 028). El checkbox NO viene marcado por
  // defecto: un consentimiento premarcado no es un consentimiento.
  const [accepted, setAccepted] = useState(false);
  const [termsVersion, setTermsVersion] = useState("");
  const [termsStale, setTermsStale] = useState(false);

  // La huella de las versiones vigentes la entrega el backend; se devuelve tal
  // cual al registrar. Si mientras se llena el formulario se publica una versión
  // nueva, el registro responde 409 y aquí se avisa (nunca se guarda la
  // aceptación de un texto que la persona no vio).
  useEffect(() => {
    let alive = true;
    fetchLegalDocuments()
      .then((d) => {
        if (alive) setTermsVersion(d.terms_version);
      })
      .catch(() => {
        // Sin catálogo no se puede aceptar nada: el submit queda bloqueado y el
        // mensaje de error del backend explica por qué.
      });
    return () => {
      alive = false;
    };
  }, []);

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
    if (!accepted) {
      setError(
        "Para crear tu cuenta tienes que aceptar los Términos y Condiciones y la Política de Tratamiento de Datos.",
      );
      return;
    }
    setError("");
    setBusy(true);
    try {
      // El payload se arma explícito: lo que se manda al backend es exactamente
      // lo que el registro declara, sin campos de UI que se cuelen.
      const user = await register({
        ...form,
        accepted_terms: true,
        terms_version: termsVersion || null,
      });
      // La cuenta nueva es admin de su venue: el mismo criterio de redirect
      // que el login (lib/roles.js) decide a dónde aterriza.
      nav(homeForRole(user), { replace: true });
    } catch (err) {
      const raw = (err?.message || "").toLowerCase();
      if (raw.includes("terminos") || raw.includes("términos")) {
        // Los términos cambiaron entre que se abrió la página y el submit.
        setTermsStale(true);
        setError(
          err?.message || "Los términos se actualizaron. Recarga la página.",
        );
      } else if (err?.status === 409 || raw.includes("ya tiene una cuenta")) {
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
    <AuthShell>
      <div className="relative w-full">
        <div className="auth-card reveal p-6 sm:p-7">
          <p className="eyebrow">Empieza gratis</p>
          <h1 className="display mt-1 mb-1 text-2xl">Crea tu cuenta</h1>
          <p className="mb-5 text-sm leading-relaxed text-zinc-400">
            Crea el panel de tu negocio en un minuto. Serás su administrador.
          </p>

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
            <div className="auth-field relative mb-4">
              <MailIcon className="auth-field-icon" />
              <input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="tu@negocio.com"
                className="field auth-field-has-icon"
                autoComplete="email"
                required
              />
            </div>

            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              Contraseña
            </label>
            <div className="auth-field relative mb-2">
              <LockIcon className="auth-field-icon" />
              <input
                type={showPass ? "text" : "password"}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder="Mínimo 8 caracteres"
                className="field mb-0 !pr-12 auth-field-has-icon"
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
                  <span className="text-2xs font-semibold text-zinc-400">
                    {strength.label}
                  </span>
                </div>
                <PasswordMeter value={form.password} />
              </div>
            )}

            {/* Aceptación de términos: bloqueante. Sin marcar, el submit está
                deshabilitado y el backend además responde 422 — la UI no es la
                cerradura, solo la explicación. */}
            <label className="mb-4 flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-zinc-400">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => {
                  setAccepted(e.target.checked);
                  if (e.target.checked) setError("");
                }}
                className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-brand-500"
                aria-describedby="terminos-aviso"
              />
              <span id="terminos-aviso">
                Acepto los{" "}
                <button
                  type="button"
                  onClick={() => nav("/terminos")}
                  className="font-semibold text-brand-300 underline decoration-brand-300/40 underline-offset-2 transition hover:text-brand-200"
                >
                  Términos y Condiciones
                </button>{" "}
                y autorizo el tratamiento de mis datos personales conforme a la{" "}
                <button
                  type="button"
                  onClick={() => nav("/privacidad")}
                  className="font-semibold text-brand-300 underline decoration-brand-300/40 underline-offset-2 transition hover:text-brand-200"
                >
                  Política de Tratamiento de Datos Personales
                </button>
                .
              </span>
            </label>

            {termsStale && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="btn-mini mb-3 w-full"
              >
                Recargar y ver los términos actualizados
              </button>
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
              disabled={busy || issues.length > 0 || !accepted}
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
    </AuthShell>
  );
}
