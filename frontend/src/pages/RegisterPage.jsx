import { useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../lib/auth";
import { homeForRole } from "../lib/roles";
import { missingList } from "../lib/passwordPolicy";
import { usernameBase } from "../lib/username";
import { fetchLegalDocuments } from "../lib/legal";
import PasswordMeter from "../components/PasswordMeter";
import { LockIcon, MailIcon } from "../components/AuthBackdrop";
import { AuthShell } from "../components/AuthShell";
import ContactSupport from "../components/ContactSupport";
import useDocumentTitle from "../lib/useDocumentTitle";

const STRENGTH = [
  { max: 2, label: "Débil", color: "bg-red-500", width: "w-1/4" },
  { max: 3, label: "Aceptable", color: "bg-amber-500", width: "w-2/4" },
  { max: 4, label: "Buena", color: "bg-emerald-500", width: "w-3/4" },
  { max: 99, label: "Excelente", color: "bg-emerald-400", width: "w-full" },
];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const FIELD_ORDER = ["full_name", "email", "password", "venue_name"];
const FIELD_INPUT_IDS = {
  full_name: "reg-full-name",
  email: "reg-email",
  password: "reg-password",
  venue_name: "reg-venue-name",
};

function focusFirstError(errors) {
  const first = FIELD_ORDER.find((key) => errors[key]);
  if (first) document.getElementById(FIELD_INPUT_IDS[first])?.focus();
}

function fieldError(id, message) {
  return (
    <p id={id} role="alert" className="mb-4 mt-1 text-xs text-red-300">
      {message}
    </p>
  );
}

export default function RegisterPage() {
  useDocumentTitle("Crear cuenta de organizador");
  const { register } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    password: "",
    venue_name: "",
  });
  const [showPass, setShowPass] = useState(false);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  // Aceptación de los términos (mig 028). El checkbox NO viene marcado por
  // defecto: un consentimiento premarcado no es un consentimiento.
  const [accepted, setAccepted] = useState(false);
  const [termsVersion, setTermsVersion] = useState("");
  const [termsStale, setTermsStale] = useState(false);
  const [retryable, setRetryable] = useState(false);

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
  const suggestedUsername = useMemo(
    () => usernameBase(form.venue_name.trim() || form.full_name.trim()),
    [form.venue_name, form.full_name],
  );

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k] || errors.general) {
      setErrors((prev) => ({ ...prev, [k]: "", general: "" }));
    }
    setRetryable(false);
  }

  function validate() {
    const next = {};
    if (form.full_name.trim().length < 2) {
      next.full_name = "Escribe tu nombre completo.";
    }
    if (!EMAIL_RE.test(form.email.trim())) {
      next.email = "Escribe un correo válido.";
    }
    if (!form.password) {
      next.password = "Escribe una contraseña.";
    } else if (issues.length > 0) {
      next.password = `A la contraseña le falta: ${issues.join(", ")}.`;
    }
    if (form.venue_name.trim() && form.venue_name.trim().length < 2) {
      next.venue_name = "El nombre del negocio debe tener al menos 2 caracteres.";
    }
    if (!accepted) {
      next.terms =
        "Para crear tu cuenta tienes que aceptar los Términos y Condiciones y la Política de Tratamiento de Datos.";
    }
    return next;
  }

  async function submitForm() {
    if (busy) return;
    const next = validate();
    if (Object.keys(next).length > 0) {
      setErrors(next);
      focusFirstError(next);
      return;
    }

    setErrors({});
    setRetryable(false);
    setBusy(true);
    try {
      // El payload se arma explícito: lo que se manda al backend es exactamente
      // lo que el registro declara, sin campos de UI que se cuelen.
      const user = await register({
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        password: form.password,
        venue_name: form.venue_name.trim() || null,
        accepted_terms: true,
        terms_version: termsVersion || null,
      });
      // La cuenta nueva es admin de su espacio: el mismo criterio de redirect
      // que el login (lib/roles.js) decide a dónde aterriza.
      nav(homeForRole(user), { replace: true });
    } catch (err) {
      const raw = (err?.message || "").toLowerCase();
      if (raw.includes("terminos") || raw.includes("términos")) {
        // Los términos cambiaron entre que se abrió la página y el submit.
        setTermsStale(true);
        setErrors({ general: err?.message || "Los términos se actualizaron. Recarga la página." });
      } else if (err?.status === 409 && raw.includes("usuario")) {
        // El backend agotó las variantes del nombre generado. No es un
        // problema del correo: se muestra como error general y se conserva
        // todo lo escrito para que la persona pueda ajustar el negocio.
        setErrors({
          general:
            err?.message ||
            "No pudimos asignar un nombre de usuario. Prueba con otro nombre de negocio.",
        });
      } else if (err?.status === 409 || raw.includes("ya tiene una cuenta")) {
        setErrors({ email: "Ese correo ya está registrado. Inicia sesión en su lugar." });
      } else if (raw.includes("demasiados") || err?.status === 429) {
        setErrors({ general: "Demasiados intentos. Espera unos minutos." });
      } else if (!err?.status || err.status >= 500) {
        // La conexión falló o el servicio no respondió: el formulario queda
        // intacto y se ofrece reintentar sin volver a escribirlo.
        setErrors({
          general:
            "No pudimos conectar con Enty. Revisa tu conexión y reintenta; tus datos siguen aquí.",
        });
        setRetryable(true);
      } else if (err?.fields) {
        const mapped = {};
        for (const key of FIELD_ORDER) {
          if (err.fields[key]) mapped[key] = err.fields[key];
        }
        if (Object.keys(mapped).length > 0) {
          setErrors(mapped);
          focusFirstError(mapped);
        } else {
          setErrors({
            general: err?.message || "No pudimos crear tu cuenta. Inténtalo de nuevo.",
          });
        }
      } else {
        setErrors({
          general: err?.message || "No pudimos crear tu cuenta. Inténtalo de nuevo.",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <div className="relative w-full">
        <div className="auth-card reveal p-6 sm:p-7">
          <h1 className="display mt-1 mb-1 text-2xl">
            Crea tu cuenta de organizador
          </h1>
          <p className="mb-5 text-sm leading-relaxed text-zinc-400">
            Publica tu primer evento y gestiona tus boletas con Enty.
          </p>

          <form onSubmit={(e) => { e.preventDefault(); submitForm(); }} noValidate>
            <label
              htmlFor="reg-full-name"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Tu nombre completo
            </label>
            <input
              id="reg-full-name"
              value={form.full_name}
              onChange={(e) => set("full_name", e.target.value)}
              placeholder="Ana Gómez"
              className="field mb-4"
              maxLength={120}
              autoComplete="name"
              required
              aria-invalid={errors.full_name ? "true" : undefined}
              aria-describedby={errors.full_name ? "reg-full-name-error" : undefined}
            />
            {errors.full_name && fieldError("reg-full-name-error", errors.full_name)}

            <label
              htmlFor="reg-email"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Correo
            </label>
            <div className="auth-field relative mb-4">
              <MailIcon className="auth-field-icon" />
              <input
                id="reg-email"
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="tu@negocio.com"
                className="field auth-field-has-icon"
                autoComplete="email"
                required
                aria-invalid={errors.email ? "true" : undefined}
                aria-describedby={errors.email ? "reg-email-error" : undefined}
              />
            </div>
            {errors.email && fieldError("reg-email-error", errors.email)}

            <label
              htmlFor="reg-password"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Contraseña
            </label>
            <div className="auth-field relative mb-2">
              <LockIcon className="auth-field-icon" />
              <input
                id="reg-password"
                type={showPass ? "text" : "password"}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder="Mínimo 8 caracteres"
                className="field mb-0 !pr-12 auth-field-has-icon"
                autoComplete="new-password"
                required
                aria-invalid={errors.password ? "true" : undefined}
                aria-describedby={
                  errors.password
                    ? "reg-password-error reg-password-help reg-password-reqs"
                    : "reg-password-help reg-password-reqs"
                }
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-100"
                aria-label={showPass ? "Ocultar contraseña" : "Mostrar contraseña"}
                aria-pressed={showPass}
              >
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

            {errors.password && fieldError("reg-password-error", errors.password)}

            {/* Un solo bloque de requisitos, siempre visible junto al campo. */}
            <div id="reg-password-help" className="mb-4">
              {form.password && (
                <div className="mb-1 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={`h-full ${strength.color} ${strength.width} transition-[width,background-color]`}
                    />
                  </div>
                  <span className="text-2xs font-semibold text-zinc-400">
                    {strength.label}
                  </span>
                </div>
              )}
              <PasswordMeter value={form.password} idPrefix="reg-password" />
            </div>

            <label
              htmlFor="reg-venue-name"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Nombre del negocio u organización
            </label>
            <input
              id="reg-venue-name"
              value={form.venue_name}
              onChange={(e) => set("venue_name", e.target.value)}
              placeholder="Bar La Esquina"
              className="field"
              maxLength={120}
              autoComplete="organization"
              aria-invalid={errors.venue_name ? "true" : undefined}
              aria-describedby={
                errors.venue_name
                  ? "reg-venue-name-hint reg-venue-name-error"
                  : "reg-venue-name-hint"
              }
            />
            <p id="reg-venue-name-hint" className="mb-2 mt-1 text-xs leading-relaxed text-zinc-500">
              Déjalo vacío si organizas por tu cuenta.
            </p>
            <p className="mb-4 text-xs leading-relaxed text-zinc-500">
              Tu usuario será{" "}
              <strong className="text-zinc-300">@{suggestedUsername}</strong>.
              Se genera con el nombre del negocio o, si lo dejas vacío, con tu
              nombre. Si ya está en uso, agregaremos un número. Podrás cambiarlo
              después.
            </p>
            {errors.venue_name && fieldError("reg-venue-name-error", errors.venue_name)}

            {/* Aceptación de términos: bloqueante. Sin marcar, el submit está
                deshabilitado y el backend además responde 422 — la UI no es la
                cerradura, solo la explicación. */}
            <label className="mb-4 flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-zinc-400">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => {
                  setAccepted(e.target.checked);
                  if (e.target.checked) {
                    setErrors((prev) => ({ ...prev, terms: "", general: "" }));
                  }
                }}
                className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-brand-500"
                aria-describedby={
                  errors.terms ? "terminos-aviso reg-terms-error" : "terminos-aviso"
                }
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
            {errors.terms && fieldError("reg-terms-error", errors.terms)}

            {termsStale && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="btn-mini mb-3 w-full"
              >
                Recargar y ver los términos actualizados
              </button>
            )}

            {errors.general && (
              <div
                id="register-error"
                role="alert"
                className="mb-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm leading-relaxed text-red-300"
              >
                {errors.general}
              </div>
            )}

            {retryable && (
              <button
                type="button"
                onClick={submitForm}
                disabled={busy}
                className="btn-mini mb-3 w-full"
              >
                Reintentar
              </button>
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
              {busy ? "Creando tu cuenta…" : "Crear mi cuenta"}
            </button>
          </form>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-zinc-400">
          <button
            onClick={() => nav("/login")}
            className="font-semibold text-brand-300 transition hover:text-brand-200"
          >
            Iniciar sesión
          </button>
          <span aria-hidden="true" className="text-zinc-600">·</span>
          <button
            onClick={() => nav("/boletas")}
            className="font-semibold text-brand-300 transition hover:text-brand-200"
          >
            Ir a Mis boletas
          </button>
        </div>

        {/* La misma salida que el login: quien no logra crear la cuenta es
            quien más necesita hablar con alguien. Reusa el bloque de la
            entrada para no tener dos contactos con copy distinto. */}
        <div className="auth-foot">
          <ContactSupport
            prompt="¿Necesitas ayuda?"
            label="Necesito ayuda"
            message="Hola, necesito ayuda para crear mi cuenta en Enty."
          />
        </div>
      </div>
    </AuthShell>
  );
}
