import { apiFetch } from "../lib/api";
import { homeForRole } from "../lib/roles";
import { useAuth } from "../lib/auth";
import { useNavigate, useLocation } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { LockIcon, MailIcon } from "../components/AuthBackdrop";
import { AuthShell } from "../components/AuthShell";
import { WelcomeOverlay } from "../components/WelcomeOverlay";
import { Logo } from "../components/Brand";
import useDocumentTitle from "../lib/useDocumentTitle";
import { withViewTransition } from "../lib/viewTransition";
import { prefersReducedMotion } from "../lib/motion";

/** Icono del ojo (mostrar/ocultar contraseña). Sin dependencias externas. */
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

/**
 * Mensaje de error legible para un fallo de login.
 * El backend ya devuelve `detail` legible para 4xx; lo que falta es el mapa
 * de los casos que el usuario sí merece entender: credenciales mal, límite de
 * intentos y caída de red.
 */
function loginErrorMessage(err) {
  const status = err?.status;
  if (status === 401) return "Usuario o contraseña incorrectos.";
  if (status === 429)
    return "Demasiados intentos. Espera un minuto e intenta de nuevo.";
  if (!status) return "No hay conexión con el servidor. Revisa tu internet.";
  return err?.message || "No se pudo iniciar sesión. Intenta de nuevo.";
}

export default function LoginPage() {
  useDocumentTitle("Ingresar");
  const { login } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const from = location.state?.from;

  const storedIdent =
    typeof window !== "undefined" ? localStorage.getItem("enty_last_email") : null;
  const [ident, setIdent] = useState(storedIdent || "");

  useEffect(() => {
    if (ident.trim().length > 0) {
      localStorage.setItem("enty_last_email", ident);
    }
  }, [ident]);

  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Momento de éxito: antes de navegar, el botón confirma que el ingreso
  // salió bien. Sin esto, el corte al panel era tan seco que la persona no
  // sabía si su click había registrado.
  const [ok, setOk] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  // Tick fuerza el re-render cuando el MISMO mensaje de error se repite
  // (dos "contraseña incorrectas" seguidas no cambian el string y React no
  // repintaría; el estado alterno garantiza que el aviso siempre se lea).
  const [errorTick, setErrorTick] = useState(0);
  const [entered, setEntered] = useState(null);
  const [capsLock, setCapsLock] = useState(false);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  // autoFocus fijo abría el teclado al entrar en móvil y provocaba salto de
  // layout y zoom. Solo se enfoca donde hay puntero fino (escritorio).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      emailRef.current?.focus();
    }
  }, []);

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
      passwordRef.current?.focus();
      return;
    }
    setError("");
    setBusy(true);
    try {
      const user = await login(ident, password);
      const home = homeForRole(user);
      if (home === "/login") {
        setError("Tu usuario no tiene un rol asignado");
        setErrorTick((n) => n + 1);
        setBusy(false);
        return;
      }
      setOk(true);
      setEntered(user);
      const pause = prefersReducedMotion() ? 320 : 1600;
      await new Promise((r) => setTimeout(r, pause));
      withViewTransition(() => nav(from || home, { replace: true }));
    } catch (err) {
      setError(loginErrorMessage(err));
      setErrorTick((n) => n + 1);
      passwordRef.current?.focus();
      setBusy(false);
    }
  }

  return (
    <AuthShell minimal tone="light">
      {/* El lienzo claro y la tarjeta son los mismos de la portada pública;
          aquí solo vive el formulario. */}
      <div className="auth-login-flow">
        {/* Marca: la variante mínima no trae panel de marca, así que el
            logotipo y la etiqueta encabezan la columna del formulario. */}
        <div className="auth-login-brand">
          <Logo size="lg" />
          <p className="auth-login-tag">Boletería, aforo y control de puerta</p>
        </div>

        <div className="auth-card auth-card-enter">
          <h1 className="auth-login-title">Iniciar sesión</h1>
          <p className="auth-login-sub">
            Entra con tu usuario o correo para continuar.
          </p>

          <form onSubmit={submit} noValidate className="auth-login-form">
            <label htmlFor="login-email" className="auth-label">
              Usuario o correo
            </label>
            <div className="auth-field auth-field--md">
              <MailIcon className="auth-field-icon" />
              <input
                ref={emailRef}
                id="login-email"
                type="text"
                name="username"
                value={ident}
                onChange={(e) => {
                  const value = e.target.value;
                  setIdent(value);
                  // Validación en vivo: solo marca cuando hay contenido.
                  // Un nombre de usuario sin @ es válido (mig 035), así que
                  // el aviso es suave y nunca bloquea el envío.
                  if (!value.includes("@") && value.trim().length > 0) {
                    setEmailError(
                      "Si usas correo, revisa que incluya @ y el dominio.",
                    );
                  } else {
                    setEmailError("");
                  }
                }}
                placeholder="usuario o tu@negocio.com"
                className="field auth-field-has-icon"
                inputMode="email"
                enterKeyHint="next"
                autoCapitalize="none"
                spellCheck={false}
                required
                aria-invalid={error || emailError ? "true" : undefined}
                aria-describedby={emailError ? "email-hint" : undefined}
              />
            </div>
            {emailError && (
              <p id="email-hint" className="auth-hint auth-hint--soft">
                {emailError}
              </p>
            )}

            <label htmlFor="login-password" className="auth-label auth-label--gap">
              Contraseña
            </label>
            <div className="auth-field auth-field--md auth-field--reveal">
              <LockIcon className="auth-field-icon" />
              <input
                id="login-password"
                type={showPass ? "text" : "password"}
                value={password}
                onChange={(e) => {
                  const value = e.target.value;
                  setPassword(value);
                  setPasswordError(
                    value.length > 0 && value.length < 6
                      ? "La contraseña debe tener al menos 6 caracteres."
                      : "",
                  );
                }}
                placeholder="Tu contraseña"
                ref={passwordRef}
                name="password"
                className="field auth-field-has-icon"
                autoComplete="current-password"
                enterKeyHint="go"
                spellCheck={false}
                required
                onKeyUp={(e) => setCapsLock(!!e.getModifierState?.("CapsLock"))}
                onKeyDown={(e) => setCapsLock(!!e.getModifierState?.("CapsLock"))}
                aria-invalid={error || passwordError ? "true" : undefined}
                aria-describedby={passwordError ? "password-hint" : undefined}
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="auth-eye"
                aria-label={
                  showPass ? "Ocultar contraseña" : "Mostrar contraseña"
                }
                aria-pressed={showPass}
              >
                <EyeIcon open={showPass} />
              </button>
            </div>
            {passwordError && (
              <p id="password-hint" className="auth-hint auth-hint--soft">
                {passwordError}
              </p>
            )}

            {capsLock && (
              <p id="login-caps" role="status" className="auth-hint auth-hint--warn">
                <svg
                  className="auth-hint-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="11" width="18" height="10" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                Bloq Mayús está activado.
              </p>
            )}

            {/* Error del servidor / credenciales: el único rojo de la
                pantalla, siempre debajo del campo que lo causó. */}
            {error && (
              <p
                key={errorTick}
                role="alert"
                className="auth-hint auth-hint--error auth-shake"
              >
                {error}
              </p>
            )}

            <div className="auth-row">
              <input
                type="checkbox"
                id="remember-me"
                name="remember-me"
                className="auth-checkbox"
                checked={
                  typeof window !== "undefined" &&
                  localStorage.getItem("enty_remember_me") === "1"
                }
                onChange={(e) => {
                  if (e.target.checked) {
                    localStorage.setItem("enty_remember_me", "1");
                  } else {
                    localStorage.removeItem("enty_remember_me");
                  }
                }}
                aria-label="Recordarme para la próxima visita"
              />
              <label htmlFor="remember-me" className="auth-row-label">
                Recordarme
              </label>
            </div>

            <button type="submit" disabled={busy || ok} className="btn-primary btn-primary--lg">
              {ok ? "¡Listo!" : busy ? "Entrando…" : "Entrar"}
            </button>

            {busy && (
              <span className="btn-spinner auth-submit-spinner" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" />
                </svg>
              </span>
            )}
          </form>

          {/* Contacto: queda fuera del form para que Enter no lo dispare. */}
          <div className="auth-foot">
            <button
              type="button"
              onClick={() => window.open("https://wa.me/qr/H4SZ7YBWO266O1", "_blank")}
              className="auth-contact"
            >
              <svg
                className="auth-contact-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 11.5a8.4 8.4 0 0 1-12.6 7.3L3 20.5l1.8-5.2A8.5 8.5 0 1 1 21 11.5z" />
              </svg>
              <span className="auth-contact-text">
                ¿Problemas para entrar?
                <strong>Contáctanos</strong>
              </span>
            </button>

            <p className="auth-trust">
              Conexión segura. Nunca te pediremos tu contraseña por chat.
            </p>
          </div>
        </div>
      </div>

      {/* Bienvenida personalizada: nombra a quien entro y hace visible la
          espera real con una barra que avanza hasta que el login responde.
          `done={ok}` cierra la animacion con el exito verdadero, no con un
          temporizador. */}
      {entered && <WelcomeOverlay user={entered} done={ok} />}
    </AuthShell>
  );
}