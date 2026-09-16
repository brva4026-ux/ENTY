import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../lib/auth";
import { Logo } from "../components/Brand";
import Icon from "../components/Icon";

/* Credenciales de la demo. Se pintan como botones porque el evaluador las
   teclea a mano una y otra vez; un clic las llena. */
const DEMO = [
  { email: "admin@bar.test", label: "Admin" },
  { email: "promo1@bar.test", label: "Promotor" },
  { email: "puerta@bar.test", label: "Puerta" },
];
const DEMO_PASSWORD = "demo1234";

const HIGHLIGHTS = [
  { icon: "ticket", title: "Boletería y cortesías", sub: "Cupos que no se sobrevenden" },
  { icon: "qr", title: "Puerta anti-reuso", sub: "Cada escaneo queda auditado" },
  { icon: "chart", title: "Reporte en vivo", sub: "Aforo, caja y fraude de un vistazo" },
];

export default function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const user = await login(email, password);
      const roles = Object.values(user.roles || {}).flat();
      if (roles.includes("admin")) nav("/admin");
      else if (roles.includes("promotor")) nav("/promotor");
      else if (roles.includes("bouncer")) nav("/bouncer");
      else setError("Tu usuario no tiene un rol asignado");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function fillDemo(demoEmail) {
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD);
    setError("");
  }

  return (
    <div className="grain relative min-h-screen overflow-hidden bg-slate-950">
      <div className="atmosphere" aria-hidden="true" />

      <div className="relative z-10 mx-auto grid min-h-screen max-w-6xl items-center gap-10 px-5 py-10 lg:grid-cols-[1.1fr_minmax(0,26rem)] lg:gap-16">
        {/* --- Relato de marca ------------------------------------------
            En movil se oculta: en una pantalla chica estorba antes que
            vender, y el formulario tiene que quedar arriba. */}
        <section className="hidden lg:block">
          <Logo size="lg" />
          <h1 className="mt-8 font-display text-5xl font-extrabold leading-[1.05] tracking-tight text-white">
            La puerta de tu bar,
            <br />
            <span className="bg-gradient-to-r from-brand-400 to-accent-400 bg-clip-text text-transparent">
              sin colarse nadie.
            </span>
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-slate-400">
            Emite boletas y cortesías por promotor, escanea el QR en la entrada y
            mira la caja y el aforo en vivo. Cada intento fallido queda registrado.
          </p>

          <ul className="mt-9 space-y-4">
            {HIGHLIGHTS.map((h, i) => (
              <li
                key={h.title}
                className="stagger flex items-start gap-3.5"
                style={{ "--i": i + 1 }}
              >
                <span className="tile mt-0.5 h-10 w-10 shrink-0">
                  <Icon name={h.icon} className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-slate-200">{h.title}</p>
                  <p className="text-sm text-slate-500">{h.sub}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* --- Formulario ------------------------------------------------ */}
        <section className="w-full">
          <div className="mb-7 flex flex-col items-center text-center lg:hidden">
            <Logo size="lg" />
          </div>

          <div className="card-lit card-hero stagger p-6 sm:p-7" style={{ "--i": 0 }}>
            <p className="eyebrow">Acceso</p>
            <h2 className="mt-1.5 font-display text-2xl font-extrabold tracking-tight text-white">
              Entra a tu panel
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Boletería, cupos y puerta en una sola app.
            </p>

            <form onSubmit={submit} className="mt-6">
              <label htmlFor="login-email" className="mb-1.5 block text-xs font-medium text-slate-400">
                Email
              </label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@bar.test"
                className="field mb-4"
                autoComplete="email"
                required
              />

              <label htmlFor="login-password" className="mb-1.5 block text-xs font-medium text-slate-400">
                Contraseña
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="field mb-4"
                autoComplete="current-password"
                required
              />

              {error && (
                <p
                  role="alert"
                  className="mb-4 flex items-start gap-2 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-300"
                >
                  <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
                  {error}
                </p>
              )}

              <button type="submit" disabled={busy} className="btn-primary w-full !py-3">
                {busy ? "Entrando…" : "Entrar"}
                {!busy && <Icon name="arrowUp" className="h-4 w-4 rotate-90" />}
              </button>
            </form>

            <div className="mt-6 border-t border-slate-800 pt-5">
              <p className="eyebrow">Probar la demo</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {DEMO.map((d) => (
                  <button
                    key={d.email}
                    type="button"
                    onClick={() => fillDemo(d.email)}
                    className="chip tap-target"
                  >
                    <Icon name="users" className="h-3.5 w-3.5" />
                    {d.label}
                  </button>
                ))}
              </div>
              <p className="mt-2.5 text-xs text-slate-600">
                Contraseña <span className="font-mono text-slate-400">{DEMO_PASSWORD}</span> para los tres.
              </p>
            </div>
          </div>

          <p className="mt-4 text-center text-xs text-slate-600">
            Al entrar aceptas que tus accesos queden registrados para auditoría.
          </p>
        </section>
      </div>
    </div>
  );
}