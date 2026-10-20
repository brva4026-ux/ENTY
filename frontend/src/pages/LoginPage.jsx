import { useLocation, useNavigate } from "react-router-dom";
import { useState, useRef, useEffect, useMemo } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import { homeForRole } from "../lib/roles";
import { LockIcon, MailIcon } from "../components/AuthBackdrop";
import { AuthShell } from "../components/AuthShell";
import useDocumentTitle from "../lib/useDocumentTitle";

/** Mismo formato de correo que exige el backend (schemas.py). Validar aquí
 *  evita un viaje al servidor para algo que ya se sabe en el navegador. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

/**
 * Traduce el error del backend a algo que la persona entiende y sabe qué hacer.
 *
 * Devuelve el mensaje YA UBICADO: `email`/`password` cuando el problema está en
 * un campo concreto (el aviso se pinta pegado a ese campo) y `general` cuando
 * el problema es de la sesión o del entorno (bloqueo, red, cuenta inactiva).
 * Antes todo caía en un único bloque rojo lejano: la persona no sabía QUÉ
 * campo corregir.
 *
 * Solo se contemplan los errores que el backend emite de verdad (ver
 * `routers/auth.py`): 401 "Correo o contraseña incorrectos", 401 "Usuario
 * inactivo", 429 por bloqueo de intentos y 422 de validación de FastAPI.
 */
function describeLoginError(err) {
  const raw = err?.message || "";
  const low = raw.toLowerCase();

  if (err?.status === 401) {
    if (low.includes("inactivo")) {
      return {
        general:
          "Tu cuenta está desactivada. Pide a un administrador de tu negocio que la reactive.",
      };
    }
    // El backend no distingue si falló el correo o la contraseña (a propósito,
    // para no revelar qué cuentas existen): un aviso que cubre ambos.
    return {
      general:
        "El correo o la contraseña no coinciden. Revisa mayúsculas, espacios y vuelve a intentar.",
    };
  }
  if (err?.status === 429) {
    return {
      general:
        "Demasiados intentos fallidos seguidos. Espera unos minutos y prueba otra vez, o recupera tu contraseña.",
    };
  }
  if (err?.status === 422) {
    // El correo ya se validó en el navegador, así que un 422 casi siempre es la
    // contraseña (max_length=128). Se deduce por el texto porque FastAPI no
    // manda el nombre del campo.
    if (low.includes("128") || low.includes("password") || low.includes("caracter")) {
      return {
        password: "La contraseña es demasiado larga (máximo 128 caracteres).",
      };
    }
    return {
      email: "Revisa el correo: parece que le falta el @ o el dominio.",
    };
  }
  if (low.includes("failed to fetch") || low.includes("network")) {
    return {
      general:
        "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.",
    };
  }
  // 5xx: el fallo es del servidor, no de la persona. Su texto no aporta (a
  // veces es "Internal Server Error"). El mensaje evita dos engaños: decirle
  // que "espere y reintente" cuando el servicio está caído (reintentar no
  // arregla nada) y dejarlo creyendo que su cuenta o contraseña fallan, lo que
  // lo empuja a un reinicio de contraseña que tampoco sirve.
  if (err?.status >= 500) {
    return {
      general:
        "El servicio no está disponible en este momento. No es tu cuenta ni tu contraseña: es una falla de nuestro lado. Vuelve a intentar más tarde; si sigue igual, avísale al equipo.",
    };
  }
  return { general: raw || "No pudimos iniciar sesión. Inténtalo de nuevo." };
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

/** Bloq Mayús: icono propio (no está en el set general porque solo se usa aquí). */
function CapsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4 4.5 12H9v4h6v-4h4.5L12 4ZM8 20h8" />
    </svg>
  );
}

/** Aviso de campo: círculo con signo. Distinto del de Bloq Mayús para que el
 *  ojo no confunda una pista con un error. */
function WarnIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </svg>
  );
}

export default function LoginPage() {
  useDocumentTitle("Ingresar");
  const { login } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const from = location.state?.from;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [generalError, setGeneralError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [capsOn, setCapsOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotMsg, setForgotMsg] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const generalErrorRef = useRef(null);

  // Mientras la persona escribe se limpia el error del campo: el aviso rojo se
  // va en cuanto empieza a corregir, no cuando acierta.
  const emailOk = useMemo(() => EMAIL_RE.test(email.trim()), [email]);

  function clearErrors() {
    setGeneralError("");
    setEmailError("");
    setPasswordError("");
  }

  async function submit(e) {
    e.preventDefault();
    clearErrors();
    // Validación local primero: un correo mal formado no merece un viaje al
    // servidor ni un "correo o contraseña incorrectos" que no dice nada.
    if (!emailOk) {
      setEmailError(
        "Escribe un correo válido, con @ y dominio. Ejemplo: usuario@negocio.com",
      );
      emailRef.current?.focus();
      return;
    }
    // Sin esto, una contraseña vacía viajaba al servidor y volvía como "el
    // correo o la contraseña no coinciden", que desorienta.
    if (!password) {
      setPasswordError("Escribe tu contraseña para continuar.");
      passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const user = await login(email, password);
      const home = homeForRole(user);
      if (home === "/login") {
        setGeneralError("Tu usuario no tiene un rol asignado.");
      } else {
        nav(from || home, { replace: true });
      }
    } catch (err) {
      const d = describeLoginError(err);
      if (d.general) setGeneralError(d.general);
      if (d.email) setEmailError(d.email);
      if (d.password) setPasswordError(d.password);
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
        "No pudimos procesar la solicitud ahora. Inténtalo en unos minutos.",
      );
    } finally {
      setForgotBusy(false);
    }
  }

  // Al fallar el ingreso, el aviso vive al lado del boton: en un movil bajo
  // queda por debajo del pliegue, asi que se trae a la vista. Enfocar el correo
  // (como antes) dejaba el aviso oculto y la persona no sabia que habia fallado.
  useEffect(() => {
    if (!generalError || !generalErrorRef.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    generalErrorRef.current.scrollIntoView({
      block: "center",
      behavior: reduce ? "auto" : "smooth",
    });
  }, [generalError]);

  return (
    <AuthShell>
      <div className="relative w-full">
        <div className="auth-card reveal p-6 sm:p-7">
          <p className="eyebrow">Tu panel</p>
          <h1 className="display mt-1 mb-1 text-2xl">Ingresar</h1>
          <p className="mb-5 text-sm leading-relaxed text-zinc-400">
            Entra con tu correo de trabajo para manejar la venta y la puerta.
          </p>

          <form onSubmit={submit} noValidate>
            <label
              htmlFor="login-email"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Correo
            </label>
            <div className="mb-4">
              <div
                className={`auth-field relative ${emailError ? "has-error" : ""}`}
              >
                <MailIcon className="auth-field-icon" />
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (emailError) setEmailError("");
                  }}
                  onBlur={() => {
                    if (email && !emailOk) {
                      setEmailError(
                        "Ese correo no parece válido. Revisa que tenga @ y el dominio.",
                      );
                    }
                  }}
                  placeholder="tu@negocio.com"
                  className="field auth-field-has-icon"
                  autoComplete="email"
                  autoFocus
                  ref={emailRef}
                  aria-invalid={emailError ? "true" : undefined}
                  aria-describedby={emailError ? "login-email-error" : undefined}
                  required
                />
              </div>
              {emailError && (
                <p id="login-email-error" className="auth-field-error" role="alert">
                  <WarnIcon />
                  <span>{emailError}</span>
                </p>
              )}
            </div>

            <label
              htmlFor="login-password"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Contraseña
            </label>
            <div className="mb-2">
              <div
                className={`auth-field relative ${passwordError ? "has-error" : ""}`}
              >
                <LockIcon className="auth-field-icon" />
                <input
                  id="login-password"
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (passwordError) setPasswordError("");
                  }}
                  onKeyUp={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
                  onKeyDown={(e) =>
                    setCapsOn(e.getModifierState?.("CapsLock") ?? false)
                  }
                  onBlur={() => setCapsOn(false)}
                  placeholder="Tu contraseña"
                  className="field mb-0 !pr-12 auth-field-has-icon"
                  autoComplete="current-password"
                  ref={passwordRef}
                  aria-invalid={passwordError ? "true" : undefined}
                  aria-describedby={
                    passwordError
                      ? "login-password-error"
                      : capsOn
                        ? "login-caps-hint"
                        : undefined
                  }
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
                  <EyeIcon open={showPass} />
                </button>
              </div>
              {capsOn && !passwordError && (
                <p id="login-caps-hint" className="auth-hint" role="status">
                  <CapsIcon />
                  <span>Bloq Mayús está activado: la contraseña distingue mayúsculas.</span>
                </p>
              )}
              {passwordError && (
                <p
                  id="login-password-error"
                  className="auth-field-error"
                  role="alert"
                >
                  <WarnIcon />
                  <span>{passwordError}</span>
                </p>
              )}
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
                  Escribe tu correo arriba y te enviamos un enlace para crear
                  una contraseña nueva.
                </p>
                <button
                  type="button"
                  disabled={forgotBusy || !email}
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
                  <p className="mt-2 text-xs leading-relaxed text-emerald-300">
                    {forgotMsg}
                  </p>
                )}
              </div>
            )}

            {generalError && (
              <div
                ref={generalErrorRef}
                role="alert"
                tabIndex={-1}
                className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm leading-relaxed text-red-300"
              >
                {generalError}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
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
              {busy ? "Entrando" : "Entrar"}
            </button>
          </form>
        </div>

        <p className="mt-5 animate-fade text-center text-sm text-zinc-400">
          ¿Nuevo en Enty?{" "}
          <button
            onClick={() => nav("/register")}
            className="link-underline font-semibold text-brand-300"
          >
            Crea tu negocio
          </button>
        </p>
      </div>
    </AuthShell>
  );
}
