import React, { lazy, Suspense } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import { homeForRole } from "../lib/roles";
import { LockIcon, MailIcon } from "../components/AuthBackdrop";
import { AuthShell } from "../components/AuthShell";
import { WelcomeOverlay } from "../components/WelcomeOverlay";
import useDocumentTitle from "../lib/useDocumentTitle";
import { withViewTransition } from "../lib/viewTransition";
import { prefersReducedMotion } from "../lib/motion";

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
  if (
    raw.toLowerCase().includes("failed to fetch") ||
    raw.toLowerCase().includes("network")
  ) {
    return "No hay conexión con el servidor. Verifica tu internet.";
  }
  return raw || "No pudimos iniciar sesión. Inténtalo de nuevo.";
}

/** Ojo mostrar/ocultar: icono trazado, mismo lenguaje visual del sistema. */
function EyeIcon({ open }) {
  return (
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
      {!open && <path d="M4.5 19.5 19.5 4.5" />}
    </svg>
  );
}

/** Checkmark que aparece con escala suave. */
function CheckIcon({ animate }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path
        d="m5 12.5 4.5 4.5L19 7"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Icono de usuario que entra con desplazamiento suave. */
function UserIcon({ user }) {
  const name = firstNameOf(user);
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 mr-2"
      aria-hidden="true"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function firstNameOf(user) {
  const full = (user?.full_name || "").trim();
  if (full) return full.split(/\s+/)[0];
  return user?.username || (user?.email || "").split("@")[0] || "";
}

export default function LoginPage() {
  useDocumentTitle("Ingresar");
  const { login } = useAuth();
  const nav = useNavigate();
  // Guard que redirige a /login deja de dónde venía: si el usuario quería
  // entrar a /perfil y no tenía sesión, aterrizó aquí. Al entrar, lo
  // devolvemos a su destino original en vez de su dashboard por defecto.
  const location = useLocation();
  const from = location.state?.from;

  // `ident` es usuario O correo (mig 035). El nombre del estado no cambia a
  // `email` porque ya no lo es; el id del input sí se conserva (`login-email`)
  // para no romper los E2E ni el autocompletado del navegador.
  const [ident, setIdent] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Momento de éxito: antes de navegar, el botón confirma que el ingreso
  // salió bien. Sin esto, el corte al panel era tan seco que la persona no
  // sabía si su click había registrado.
  const [ok, setOk] = useState(false);
  // Usuario que acaba de entrar. Con él se pinta la bienvenida personalizada
  // ("Hola, Ana"), así que se guarda el objeto completo, no solo un booleano.
  const [entered, setEntered] = useState(null);
  // Sacudida del bloque de error: la señal de rechazo se SIENTE, no solo se
  // lee. `key` remonta el bloque para que la animación corra en cada intento.
  const [errorTick, setErrorTick] = useState(0);
  // Foco al campo corregible cuando falla el ingreso: el mensaje es genérico
  // (no revela si falló el correo o la contraseña), así que se lleva el foco a
  // la contraseña, que es lo que la persona suele poder corregir.
  const passRef = useRef(null);
  const emailRef = useRef(null);
  // Aviso de Bloq Mayús: la causa más común de "mi contraseña es correcta y
  // no entra" en escritorio.
  const [capsLock, setCapsLock] = useState(false);

  // autoFocus fijo abría el teclado al entrar en móvil y provocaba salto de
  // layout y zoom. Solo se enfoca donde hay puntero fino (escritorio).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      emailRef.current?.focus();
    }
  }, []);

  // Recuperación de contraseña
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotMsg, setForgotMsg] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    // El form lleva noValidate: sin el, el navegador corta el envio con
    // "Please fill out this field." en ingles antes de que corra este codigo.
    if (!ident.trim()) {
      setError("Escribe tu correo.");
      setErrorTick((n) => n + 1);
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      setError("Escribe tu contraseña.");
      setErrorTick((n) => n + 1);
      passRef.current?.focus();
      return;
    }
    setError("");
    setBusy(true);
    try {
      const user = await login(ident, password);
      // Un solo criterio de redirect (lib/roles.js): re-hacerlo aquí
      // desincroniza y dejó afuera a super_admin (sus roles no incluyen
      // el string "admin"). homeForRole devuelve "/login" solo si no hay
      // ningún rol conocido.
      const home = homeForRole(user);
      if (home === "/login") {
        setError("Tu usuario no tiene un rol asignado");
        setBusy(false);
        return;
      }
      // Confirmación breve antes de cruzar: el botón pasa a "Listo" y la
      // navegación entra con transición de vista (la tarjeta se disuelve y el
      // panel aparece). Con movimiento reducido el aviso dura un instante y
      // el salto es directo: la preferencia manda.
      setOk(true);
      // La bienvenida se queda visible un momento para que el saludo y la barra
      // se lean antes de cruzar. El overlay se monta con el login YA resuelto,
      // así que su única animación visible es el llenado de la barra (CSS,
      // 1000ms): el margen debe cubrirlo o la persona ve un parpadeo y un
      // panel. Con movimiento reducido el margen es mínimo: la preferencia
      // manda y no se hace esperar a nadie.
      setEntered(user);
      const pause = prefersReducedMotion() ? 320 : 1600;
      await new Promise((r) => setTimeout(r, pause));
      withViewTransition(() => nav(from || home, { replace: true }));
    } catch (err) {
      setError(loginErrorMessage(err));
      setErrorTick((n) => n + 1);
      passRef.current?.focus();
      setBusy(false);
    }
  }

  async function submitForgot(e) {
    e.preventDefault();
    setForgotBusy(true);
    setForgotMsg("");
    try {
      await apiFetch("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: ident }),
      });
      // Mensaje deliberadamente genérico: repetir el `detail` del backend
      // permitiría enumerar qué correos existen en la plataforma.
      setForgotMsg(
        "Si el correo está registrado, te enviamos un enlace para crear una contraseña nueva.",
      );
    } catch (err) {
      setForgotMsg(
        "No pudimos procesar la solicitud ahora. Inténtalo en unos minutos.",
      );
    } finally {
      setForgotBusy(false);
    }
  }

  return (
    <AuthShell minimal>
      <div className="relative w-full">
        <div className="auth-card reveal p-6 sm:p-7">
          <p className="eyebrow">Tu panel</p>
          <h1 className="display mt-1 mb-1 text-2xl">Ingresar</h1>
          <p className="mb-5 text-sm leading-relaxed text-zinc-400">
            Entra con tu usuario o tu correo para manejar la venta y la puerta.
          </p>

          <form onSubmit={submit} noValidate>
            <label
              htmlFor="login-email"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Usuario o correo
            </label>
            <div className="auth-field relative mb-4">
              <MailIcon className="auth-field-icon" />
              {/* El campo acepta usuario O correo (mig 035). Va como
                  type="text" y no "email": un nombre de usuario no es un
                  correo y el navegador lo marcaria invalido antes de que el
                  backend pueda resolverlo. inputMode="email" si trae la fila
                  con @ y . al teclado movil, que sirve para las dos formas. */}
              <input
                ref={emailRef}
                id="login-email"
                type="text"
                name="username"
                value={ident}
                onChange={(e) => setIdent(e.target.value)}
                placeholder="usuario o tu@negocio.com"
                className="field auth-field-has-icon"
                inputMode="email"
                enterKeyHint="next"
                autoCapitalize="none"
                spellCheck={false}
                required
                aria-invalid={error ? "true" : undefined}
                aria-describedby={error ? "login-error" : undefined}
              />
            </div>

            <label
              htmlFor="login-password"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Contraseña
            </label>
            <div className="auth-field relative mb-2">
              <LockIcon className="auth-field-icon" />
              <input
                id="login-password"
                type={showPass ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Tu contraseña"
                ref={passRef}
                name="password"
                className="field mb-0 !pr-12 auth-field-has-icon"
                autoComplete="current-password"
                enterKeyHint="go"
                spellCheck={false}
                required
                onKeyUp={(e) => setCapsLock(!!e.getModifierState?.("CapsLock"))}
                onKeyDown={(e) => setCapsLock(!!e.getModifierState?.("CapsLock"))}
                aria-invalid={error ? "true" : undefined}
                aria-describedby={[
                  error ? "login-error" : null,
                  capsLock ? "login-caps" : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined}
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-100"
                aria-label={
                  showPass ? "Ocultar contraseña" : "Mostrar contraseña"
                }
                aria-pressed={showPass}
              >
                <EyeIcon open={showPass} />
              </button>
            </div>

            {capsLock && (
              <p
                id="login-caps"
                role="status"
                className="mb-2 -mt-1 text-xs font-medium text-zinc-400"
              >
                Bloq Mayús está activado.
              </p>
            )}

            <button
              type="button"
              onClick={() => {
                setForgotOpen((v) => !v);
                setForgotMsg("");
              }}
              className="mb-2 inline-flex min-h-11 items-center text-xs font-medium text-brand-300 transition hover:text-brand-200"
            >
              ¿Olvidaste tu contraseña?
            </button>

            {forgotOpen && (
              <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="mb-2 text-xs leading-relaxed text-zinc-400">
                  Escribe tu correo arriba y te enviamos un enlace para crear
                  una contraseña nueva.
                </p>
                <button
                  type="button"
                  disabled={forgotBusy || !ident}
                  onClick={submitForgot}
                  className="btn-ghost w-full text-xs font-bold disabled:opacity-40"
                >
                  {forgotBusy ? (
                    <>
                      <svg
                        className="btn-spinner"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="9" />
                      </svg>
                      Enviando
                    </>
                  ) : (
                    "Enviar enlace de recuperación"
                  )}
                </button>
                {forgotMsg && (
                  <p
                    role="status"
                    aria-live="polite"
                    className="mt-2 text-xs leading-relaxed text-zinc-300"
                  >
                    {forgotMsg}
                  </p>
                )}
              </div>
            )}

            {error && (
              <div
                key={errorTick}
                id="login-error"
                role="alert"
                className="auth-error mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm leading-relaxed text-red-300"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy || ok}
              className={`btn-primary w-full ${ok ? "is-ok" : ""}`}
            >
              {busy && !ok && (
                <svg
                  className="btn-spinner"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )}
              {ok && (
                <svg
                  className="btn-check"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m5 12.5 4.5 4.5L19 7" />
                </svg>
              )}
              {ok ? "Listo" : busy ? "Entrando" : "Entrar"}
            </button>

            <p className="mt-3 text-center text-xs leading-relaxed text-zinc-400">
              Conexión segura. Nunca te pediremos tu contraseña por chat.
            </p>
          </form>
        </div>

        {/* Bienvenida personalizada: se monta al entrar y se va con la ruta
            cuando el padre navega. `done` es el exito REAL del login: es lo
            que cierra la barra, no un temporizador decorativo. */}{entered && (
          <WelcomeOverlay user={entered} done={ok} />
        )}
      </div>
    </AuthShell>
  );
}