import { useLocation, useNavigate } from "react-router-dom";
import { useState, useRef, useEffect } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import { homeForRole } from "../lib/roles";
import { LockIcon, MailIcon } from "../components/AuthBackdrop";
import { AuthShell } from "../components/AuthShell";
import useDocumentTitle from "../lib/useDocumentTitle";

/** Traduce errores técnicos del backend a mensajes que una persona entiende
 *  y sabe qué hacer después. */
function loginErrorMessage(err) {
  const raw = err?.message || "";
  if (err?.status === 401) {
    if (raw.toLowerCase().includes("inactivo")) {
      return "Tu cuenta está desactivada. Pide a un administrador de tu negocio que la reactive.";
    }
    // Verificar si es error de formato de correo (no menciona contraseña)
    if (!raw.toLowerCase().includes("contraseña") && !raw.toLowerCase().includes("password")) {
      return "El correo electrónico no tiene un formato correcto. Ejemplo: usuario@negocio.com";
    }
    // Verificar si la contraseña es muy corta
    if (raw.toLowerCase().includes("mínimo") || raw.toLowerCase().includes("minimum") || raw.toLowerCase().includes("short")) {
      return "La contraseña debe tener al menos 6 caracteres.";
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

/** Componente de error con auto-cierre (5s) y enfocado automáticamente */
function LoginError({ ref, message, duration = 5000 }) {
  const [show, setShow] = useState(true);
  const timeoutRef = useRef(null);

  useEffect(() => {
    if (show) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setShow(false), duration);
    }
  }, [show]);

  return show && (
    <div
      role="alert"
      className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm leading-relaxed text-red-300"
    >
      {message}
    </div>
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotMsg, setForgotMsg] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const emailRef = useRef(null);

  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotMsg, setForgotMsg] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const user = await login(email, password);
      const home = homeForRole(user);
      if (home === "/login") {
        setError("Tu usuario no tiene un rol asignado");
      } else {
        nav(from || home, { replace: true });
      }
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
        "No pudimos procesar la solicitud ahora. Inténtalo en unos minutos.",
      );
    } finally {
      setForgotBusy(false);
    }
  }

  // Enfocar email cuando el mensaje de error cambie
  useEffect(() => {
    if (error && emailRef.current) {
      emailRef.current.focus();
      emailRef.current.select();
    }
  }, [error]);

  return (
    <AuthShell>
      <div className="relative w-full">
        <div className="auth-card reveal p-6 sm:p-7">
          <p className="eyebrow">Tu panel</p>
          <h1 className="display mt-1 mb-1 text-2xl">Ingresar</h1>
          <p className="mb-5 text-sm leading-relaxed text-zinc-400">
            Entra con tu correo de trabajo para manejar la venta y la puerta.
          </p>

          <form onSubmit={submit}>
            <label
              htmlFor="login-email"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Correo
            </label>
            <div className="auth-field relative mb-4">
              <MailIcon className="auth-field-icon" />
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="tu@negocio.com"
                className="field auth-field-has-icon"
                autoComplete="email"
                autoFocus
                ref={emailRef}
                required
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
                className="field mb-0 !pr-12 auth-field-has-icon"
                autoComplete="current-password"
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
                </button>
                <button
                  type="button"
                  disabled={forgotBusy || !email}
                  onClick={submitForgot}
                
