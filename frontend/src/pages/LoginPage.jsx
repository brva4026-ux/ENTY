import { homeForRole } from "../lib/roles";
import { useAuth } from "../lib/auth";
import { useNavigate, useLocation } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { LockIcon, MailIcon } from "../components/AuthBackdrop";
import { AuthShell } from "../components/AuthShell";
import ContactSupport from "../components/ContactSupport";
import { WelcomeOverlay } from "../components/WelcomeOverlay";
import { Logo } from "../components/Brand";
import TransitionLink from "../components/TransitionLink";
import useDocumentTitle from "../lib/useDocumentTitle";
import { forgotPassword } from "../lib/api";
import { withViewTransition } from "../lib/viewTransition";
import { prefersReducedMotion } from "../lib/motion";
import { useI18n } from "../i18n";

/** Etiqueta de cada idioma en su propia lengua (así se reconoce sin traducir). */
const LANGUAGE_LABELS = { es: "Español", en: "English" };

/** Selector de idioma del pie del login: dos botones, el activo marcado. */
function LanguageToggle() {
  const { locale, setLocale, locales } = useI18n();
  return (
    <p className="auth-lang" role="group" aria-label="Idioma / Language">
      {locales.map((loc) => (
        <button
          key={loc}
          type="button"
          className="auth-lang-btn"
          aria-pressed={locale === loc}
          onClick={() => setLocale(loc)}
        >
          {LANGUAGE_LABELS[loc] ?? loc}
        </button>
      ))}
    </p>
  );
}

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
function loginErrorMessage(err, t) {
  const status = err?.status;
  if (status === 401) return t("login.errors.badCredentials");
  if (status === 429) return t("login.errors.tooMany");
  if (!status) return t("login.errors.network");
  return err?.message || t("login.errors.generic");
}

export default function LoginPage() {
  const { t } = useI18n();
  useDocumentTitle(t("login.documentTitle"));
  const { login } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const from = location.state?.from;

  // "Recordarme" decide la VIDA de la cookie de sesion (el backend la emite
  // persistente o de sesion). Por defecto marcado, como el comportamiento
  // historico; solo se desmarca si la persona lo pide (dispositivo compartido
  // en la puerta).
  const [remember, setRemember] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("enty_remember_me") !== "0";
  });

  // El correo se recuerda junto con "Recordarme": en un dispositivo compartido
  // no recordar la sesion tampoco debe dejar el correo de la persona anterior.
  const storedIdent =
    typeof window !== "undefined" && remember
      ? localStorage.getItem("enty_last_email")
      : null;
  const [ident, setIdent] = useState(storedIdent || "");

  useEffect(() => {
    if (!remember) {
      localStorage.removeItem("enty_last_email");
      return;
    }
    if (ident.trim().length > 0) {
      localStorage.setItem("enty_last_email", ident);
    }
  }, [ident, remember]);

  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Momento de éxito: antes de navegar, el botón confirma que el ingreso
  // salió bien. Sin esto, el corte al panel era tan seco que la persona no
  // sabía si su click había registrado.
  const [ok, setOk] = useState(false);
  // `final` se pone en true en el éxito (con acceso) o en el error. Mientras
  // no llegue a ninguno, el spinner del botón sigue sumando y la tarjeta de
  // bienvenida puede seguir mostrando la espera. Con `busy` basta para
  // evitar que el mismo submit se lanze dos veces: React guarda la ultima
  // promesa y el botón se queda en estado real, no hace dos click a la vez.
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  // Tick fuerza el re-render cuando el MISMO mensaje de error se repite
  // (dos "contraseña incorrectas" seguidas no cambian el string y React no
  // repintaría; el estado alterno garantiza que el aviso siempre se lea).
  const [errorTick, setErrorTick] = useState(0);
  const [entered, setEntered] = useState(null);
  const [capsLock, setCapsLock] = useState(false);
  // Recuperación de acceso: se pide el enlace desde el propio login (antes el
  // endpoint existía pero NINGUNA pantalla lo llamaba). `forgotSent` muestra
  // la respuesta genérica del backend en el mismo lugar donde aparecería el
  // error del formulario, para no inventar un segundo patrón de aviso.
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotSent, setForgotSent] = useState("");
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
      setError(t("login.errors.requiredEmail"));
      setErrorTick((n) => n + 1);
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      setError(t("login.errors.requiredPassword"));
      setErrorTick((n) => n + 1);
      passwordRef.current?.focus();
      return;
    }
    setError("");
    setBusy(true);
    try {
      const user = await login(ident, password, { remember });
      const home = homeForRole(user);
      if (home === "/login") {
        setError(t("login.errors.noRole"));
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
      setError(loginErrorMessage(err, t));
      setErrorTick((n) => n + 1);
      passwordRef.current?.focus();
      setBusy(false);
    }
  }

  // Si por cualquier motivo la pantalla de bienvenida se queda abierta sin
  // que el login haya terminado con éxito, la cerramos para no dejar al
  // usuario pegado mirando una pantalla que no cambia.
  useEffect(() => {
    if (entered && !ok) {
      setEntered(null);
    }
  }, [entered, ok]);

  // "¿Olvidaste tu contraseña?": usa el correo ya escrito en el campo de
  // acceso (es el mismo dato). Sin correo, se pide enfocando el campo, no con
  // un modal nuevo.
  async function requestReset() {
    const email = ident.trim();
    if (!email.includes("@")) {
      setError(t("login.errors.forgotNeedEmail"));
      setErrorTick((n) => n + 1);
      emailRef.current?.focus();
      return;
    }
    setError("");
    setForgotSent("");
    setForgotBusy(true);
    try {
      const r = await forgotPassword(email);
      // El backend decide el texto: promete un enlace solo si el correo está
      // configurado; si no, orienta al reset operado por admin. Este fallback
      // (solo si la respuesta viniera sin `detail`) es neutral a propósito.
      setForgotSent(r?.detail || t("login.errors.forgotFallback"));
    } catch (err) {
      setError(err?.message || t("login.errors.forgotSend"));
      setErrorTick((n) => n + 1);
    } finally {
      setForgotBusy(false);
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
          <p className="auth-login-tag">{t("login.brandTag")}</p>
        </div>

        <div className="auth-card auth-card-enter">
          <h1 className="auth-login-title">{t("login.title")}</h1>
          <p className="auth-login-sub">{t("login.subtitle")}</p>

          <form onSubmit={submit} noValidate className="auth-login-form">
            <label htmlFor="login-email" className="auth-label">
              {t("login.labelIdent")}
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
                    setEmailError(t("login.emailHint"));
                  } else {
                    setEmailError("");
                  }
                }}
                placeholder={t("login.placeholderIdent")}
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
              {t("login.labelPassword")}
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
                      ? t("login.passwordHint")
                      : "",
                  );
                }}
                placeholder={t("login.placeholderPassword")}
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
                  showPass ? t("login.hidePassword") : t("login.showPassword")
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
                {t("login.capsLock")}
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

            {/* Respuesta al pedir el enlace de recuperación. Misma familia de
                aviso que los errores, pero en verde de confirmación: el texto
                genérico del backend no distingue si el correo existe. */}
            {forgotSent && (
              <p role="status" className="auth-hint auth-hint--ok">
                {forgotSent}
              </p>
            )}

            <div className="auth-row">
              <input
                type="checkbox"
                id="remember-me"
                name="remember-me"
                className="auth-checkbox"
                checked={remember}
                onChange={(e) => {
                  setRemember(e.target.checked);
                  // Se guarda "1"/"0" explicito: borrar la clave volveria al
                  // default (marcado) y el "no recordarme" no sobreviviria.
                  localStorage.setItem(
                    "enty_remember_me",
                    e.target.checked ? "1" : "0",
                  );
                }}
                aria-label={t("login.rememberAria")}
              />
              <label htmlFor="remember-me" className="auth-row-label">
                {t("login.remember")}
              </label>
              <button
                type="button"
                onClick={requestReset}
                disabled={forgotBusy}
                className="auth-forgot"
              >
                {forgotBusy ? t("login.forgotBusy") : t("login.forgot")}
              </button>
            </div>

            <button type="submit" disabled={busy || ok} className="btn-primary btn-primary--lg">
              {ok
                ? t("login.submitOk")
                : busy
                  ? t("login.submitBusy")
                  : t("login.submit")}
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
            <ContactSupport
              prompt={t("login.contactPrompt")}
              label={t("login.contactLabel")}
              message={t("login.contactMessage")}
            />

            <p className="auth-trust">{t("login.trust")}</p>

            {/* Sin este enlace /register era una ruta inalcanzable: existía,
                funcionaba y nadie podía llegar a ella desde la entrada. */}
            <p className="auth-alt">
              {t("login.noAccount")}{" "}
              <TransitionLink to="/register" className="auth-alt-link">
                {t("login.createAccount")}
              </TransitionLink>
            </p>

            {/* Selector de idioma: la UI nace en español (default del
                producto); aquí la persona puede cambiarla y la elección se
                recuerda (localStorage enty_locale). Solo dos idiomas hoy. */}
            <LanguageToggle />
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