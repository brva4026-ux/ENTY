import { apiFetch } from "../lib/api";
import { homeForRole } from "../lib/roles";
import { useAuth } from "../lib/auth";
import { useNavigate, useLocation } from "react-router-dom";
import { LockIcon, MailIcon } from "../components/AuthBackdrop";
import { AuthShell } from "../components/AuthShell";
import { WelcomeOverlay } from "../components/WelcomeOverlay";
import useDocumentTitle from "../lib/useDocumentTitle";
import { withViewTransition } from "../lib/viewTransition";
import { prefersReducedMotion } from "../lib/motion";
import TransitionLink from "../components/TransitionLink";
import { LoginVideo } from "../components/LoginVideo";

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
  // (("Hola, Ana")), así que se guarda el objeto completo, no solo un booleano.
  const [entered, setEntered] = useState(null);

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
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      setError("Escribe tu contraseña.");
      passwordRef.current?.focus();
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
      passwordRef.current?.focus();
      setBusy(false);
    }
  }

  return (
    <AuthShell minimal>
      <div className="relative w-full">
        <LoginVideo />
        <div className="auth-card reveal p-6 sm:p-7 auth-card-enter">
          <h1 className="display mt-1 mb-1 text-2xl">Iniciar sesión</h1>
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
                ref={passwordRef}
                name="password"
                className="field mb-0 !pr-12 auth-field-has-icon"
                autoComplete="current-password"
                enterKeyHint="go"
                spellCheck={false}
                required
                onKeyUp={(e) => setCapsLock(!!e.getModifierState?.("CapsLock"))}
                onKeyDown={(e) => setCapsLock(!!e.getModifierState?.("CapsLock"))}
                aria-invalid={error ? "true" : undefined}
                aria-describedby={error ? "login-error" : undefined}
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
              onClick={() => window.open("https://wa.me/qr/H4SZ7YBWO266O1", "_blank")}
              className="mb-2 inline-flex min-h-11 items-center text-xs font-medium text-brand-300 transition hover:text-brand-200"
            >
              ¿Problemas para entrar? Contáctanos
            </button>

            <button
              type="submit"
              disabled={busy || ok}
              className={`btn-primary w-full ${ok ? "is-ok" : ""}`}
            >
              {ok ? "Listo" : busy ? "Entrando" : "Entrar"}
            </button>

            <p className="mt-3 text-center text-xs leading-relaxed text-zinc-400">
              Conexión segura. Nunca te pediremos tu contraseña por chat.
            </p>
          </form>
        </div>
      </div>
    </AuthShell>
  );
}