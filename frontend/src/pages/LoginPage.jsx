import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { LockIcon, MailIcon } from "../components/AuthBackdrop";
import ContactSupport from "../components/ContactSupport";
import Icon from "../components/Icon";
import { LoginShell } from "../components/LoginShell";
import TransitionLink from "../components/TransitionLink";
import { WelcomeOverlay } from "../components/WelcomeOverlay";
import { useI18n } from "../i18n";
import { forgotPassword } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  destinationFor,
  operationalRoles,
  preferredRoleFor,
  taskFromPath,
} from "../lib/roles";
import useDocumentTitle from "../lib/useDocumentTitle";
import { withViewTransition } from "../lib/viewTransition";

const LANGUAGE_LABELS = { es: "Español", en: "English" };

function LanguageToggle() {
  const { locale, setLocale, locales } = useI18n();
  return (
    <select className="login-language" value={locale} onChange={(event) => setLocale(event.target.value)} aria-label="Idioma / Language">
      {locales.map((value) => (
        <option key={value} value={value}>{LANGUAGE_LABELS[value] ?? value}</option>
      ))}
    </select>
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
  const from = location.state?.from || null;
  const task = location.state?.task || taskFromPath(from);
  const taskKey =
    task?.kind === "door" || task?.kind === "invitation" ? task.kind : null;

  const [view, setView] = useState("login");
  const [remember, setRemember] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("enty_remember_me") !== "0";
  });

  const storedIdent =
    typeof window !== "undefined" && remember
      ? localStorage.getItem("enty_last_email")
      : null;
  const [ident, setIdent] = useState(storedIdent || "");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [entered, setEntered] = useState(null);
  const [selectedRole, setSelectedRole] = useState(null);
  const [capsLock, setCapsLock] = useState(false);
  const [errorTick, setErrorTick] = useState(0);

  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotSent, setForgotSent] = useState("");
  const [forgotError, setForgotError] = useState("");

  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const forgotRef = useRef(null);
  const navTimer = useRef(0);

  useEffect(() => {
    if (!remember) {
      localStorage.removeItem("enty_last_email");
      return;
    }
    if (ident.trim().length > 0) localStorage.setItem("enty_last_email", ident);
  }, [ident, remember]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (view === "forgot") forgotRef.current?.focus();
    else emailRef.current?.focus();
  }, [view]);

  useEffect(() => {
    return () => window.clearTimeout(navTimer.current);
  }, []);

  useEffect(() => {
    if (entered && !ok) setEntered(null);
  }, [entered, ok]);

  function enterWith(role, user = entered) {
    if (!role || !user) return;
    window.clearTimeout(navTimer.current);
    const target = destinationFor(role, from, task);
    withViewTransition(() => nav(target, { replace: true }));
  }

  async function submit(e) {
    e.preventDefault();
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
      const roles = operationalRoles(user);
      if (!roles.length) {
        setError(t("login.errors.noRole"));
        setErrorTick((n) => n + 1);
        setBusy(false);
        return;
      }
      const preferred = preferredRoleFor(user, roles, task, from);
      setEntered(user);
      setSelectedRole(preferred);
      setOk(true);
      setBusy(false);
      if (roles.length === 1) {
        const pause = 6000;
        navTimer.current = window.setTimeout(
          () => enterWith(preferred, user),
          pause,
        );
      }
    } catch (err) {
      setError(loginErrorMessage(err, t));
      setErrorTick((n) => n + 1);
      passwordRef.current?.focus();
      setBusy(false);
    }
  }

  function openForgot() {
    setForgotEmail(ident.includes("@") ? ident.trim() : "");
    setForgotError("");
    setForgotSent("");
    setError("");
    setPasswordError("");
    setPassword("");
    setView("forgot");
  }

  function backToLogin() {
    // El identificador original (p. ej. un @usuario) manda: la recuperación
    // solo rellena el campo si la persona llegó sin haber escrito nada.
    if (!ident.trim() && forgotEmail.trim()) setIdent(forgotEmail.trim());
    setView("login");
  }

  async function submitForgot(e) {
    e.preventDefault();
    const email = forgotEmail.trim();
    if (!email) {
      setForgotError(t("login.errors.requiredEmail"));
      forgotRef.current?.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setForgotError(t("login.errors.invalidEmail"));
      forgotRef.current?.focus();
      return;
    }
    setForgotError("");
    setForgotSent("");
    setForgotBusy(true);
    try {
      const r = await forgotPassword(email);
      setForgotSent(r?.detail || t("login.errors.forgotFallback"));
    } catch (err) {
      setForgotError(err?.message || t("login.errors.forgotSend"));
    } finally {
      setForgotBusy(false);
    }
  }

  const recovery = view === "forgot";

  return (
    <LoginShell accent={selectedRole} footerControl={<LanguageToggle />}>
      <div className="login-card auth-login-flow">
        {taskKey && !recovery && (
          <div className="login-context" role="note">
            <span className="login-context-icon" aria-hidden="true">
              <Icon
                name={taskKey === "door" ? "qr" : "ticket"}
                className="h-5 w-5"
              />
            </span>
            <div>
              <strong>{t(`login.context.${taskKey}`)}</strong>
              <span>{t(`login.context.${taskKey}Hint`)}</span>
            </div>
          </div>
        )}

        {recovery ? (
          <>
            <button type="button" className="login-back" onClick={backToLogin}>
              <Icon name="back" className="h-4 w-4" />
              {t("login.recoveryBack")}
            </button>
            <h1 className="login-title">{t("login.recoveryTitle")}</h1>
            <p className="login-sub">{t("login.recoveryIntro")}</p>

            <form onSubmit={submitForgot} noValidate className="login-form">
              <label htmlFor="forgot-email" className="auth-label">
                {t("login.recoveryLabel")}
              </label>
              <div className="auth-field auth-field--md">
                <MailIcon className="auth-field-icon" />
                <input
                  ref={forgotRef}
                  id="forgot-email"
                  type="email"
                  name="email"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  placeholder={t("login.recoveryPlaceholder")}
                  className="field auth-field-has-icon"
                  autoComplete="email"
                  inputMode="email"
                  enterKeyHint="send"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  aria-invalid={forgotError ? "true" : undefined}
                  aria-describedby={forgotError ? "forgot-error" : undefined}
                />
              </div>

              {forgotError && (
                <p id="forgot-error" role="alert" className="auth-hint auth-hint--error">
                  {forgotError}
                </p>
              )}
              {forgotSent && (
                <p role="status" className="auth-hint auth-hint--ok">
                  {forgotSent}
                </p>
              )}

              <button
                type="submit"
                disabled={forgotBusy}
                className="btn-primary login-submit"
              >
                {forgotBusy ? t("login.recoveryBusy") : t("login.recoverySubmit")}
              </button>
              <p className="login-recovery-hint">{t("login.recoveryHint")}</p>
            </form>

            <div className="login-actions">
              <ContactSupport
                prompt=""
                label={t("login.contactLabel")}
                message={t("login.contactMessage")}
                className="login-action login-action--help"
              />
            </div>
          </>
        ) : (
          <>
            <h1 className="login-title">{t("login.title")}</h1>

            <form onSubmit={submit} noValidate className="login-form">
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
                  onChange={(e) => setIdent(e.target.value)}
                  placeholder={t("login.placeholderIdent")}
                  className="field auth-field-has-icon"
                  autoComplete="username"
                  inputMode="email"
                  enterKeyHint="next"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  aria-invalid={error ? "true" : undefined}
                  aria-describedby={error ? "login-error" : undefined}
                />
              </div>

              <div className="login-password-label">
                <label htmlFor="login-password" className="auth-label">
                  {t("login.labelPassword")}
                </label>
                <button type="button" onClick={openForgot} className="auth-forgot">
                  {t("login.forgot")}
                </button>
              </div>
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
                  <Icon name="lock" className="auth-hint-icon" />
                  {t("login.capsLock")}
                </p>
              )}

              {error && (
                <p
                  key={errorTick}
                  id="login-error"
                  role="alert"
                  className="auth-hint auth-hint--error auth-shake"
                >
                  {error}
                </p>
              )}

              <div className="login-options">
                <label className="login-remember" htmlFor="remember-me">
                  <input
                    type="checkbox"
                    id="remember-me"
                    name="remember-me"
                    className="auth-checkbox"
                    checked={remember}
                    onChange={(e) => {
                      setRemember(e.target.checked);
                      localStorage.setItem(
                        "enty_remember_me",
                        e.target.checked ? "1" : "0",
                      );
                    }}
                    aria-label={t("login.rememberAria")}
                  />
                  <span>{t("login.remember")}</span>
                </label>
              </div>

              <button
                type="submit"
                disabled={busy || ok}
                className="btn-primary login-submit"
                aria-busy={busy}
              >
                {ok
                  ? t("login.submitOk")
                  : busy
                    ? t("login.submitBusy")
                    : t("login.submit")}
              </button>
            </form>

            <div className="login-secondary">
              <div className="login-register">
                <TransitionLink to="/register" className="login-action">
                  {t("login.createAccount")}
                </TransitionLink>
              </div>
              <div className="login-utility">
                <TransitionLink to="/boletas" className="login-action">
                  {t("login.myTickets")}
                </TransitionLink>
                <ContactSupport
                  prompt=""
                  label={t("login.contactLabel")}
                  message={t("login.contactMessage")}
                  className="login-action login-action--help"
                />
              </div>
            </div>
          </>
        )}
      </div>

      {entered && (
        <WelcomeOverlay
          user={entered}
          role={selectedRole}
          roles={operationalRoles(entered)}
          onSelectRole={setSelectedRole}
          onContinue={() => enterWith(selectedRole)}
        />
      )}
    </LoginShell>
  );
}
