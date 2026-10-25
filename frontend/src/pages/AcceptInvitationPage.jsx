/* Página pública de canje de invitación (/invitacion?token=...).
 *
 * El invitado ve para qué negocio y con qué rol lo invitaron, crea SU
 * contraseña y entra directo (sesión creada por el backend). El token viaja
 * en la query pero en la DB solo vive su hash: este enlace ES el secreto,
 * como una boleta.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Brand";
import { apiFetch } from "../lib/api";
import useDocumentTitle from "../lib/useDocumentTitle";

const ROLE_LABEL = { promotor: "Promotor", bouncer: "Portero", admin: "Administrador" };

/* Destino y explicación del rol: el nuevo integrante nunca aterriza a ciegas.
 * La sesión ya quedó creada (el backend devuelve el access_token al canjear),
 * así que estos enlaces entran directo sin volver a pasar por login. */
const ROLE_HOME = { admin: "/admin", promotor: "/promotor", bouncer: "/bouncer" };
const ROLE_WELCOME = {
  admin:
    "Entras al panel de administración: creas el evento y su backstage te lleva paso a paso (tipos, cupos, equipo y caja).",
  promotor:
    "Entras a tu panel: eliges el evento y emites boletas desde tu cupo. El enlace de cada boleta se comparte por WhatsApp.",
  bouncer:
    "Entras al escáner: eliges el evento en puerta y escaneas. Recuerda: el QR del invitado solo se activa en la ventana del evento.",
};

/* Medidor de contraseña: guía sin exigir adivinar reglas. */
function passStrength(p) {
  let score = 0;
  if (p.length >= 8) score++;
  if (p.length >= 12) score++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) score++;
  if (/\d/.test(p)) score++;
  if (/[^A-Za-z0-9]/.test(p)) score++;
  return score;
}

export default function AcceptInvitationPage() {
  useDocumentTitle("Invitación");
  const [params] = useSearchParams();
  const token = params.get("token") || "";

  const [preview, setPreview] = useState(null);
  const [phase, setPhase] = useState("loading"); // loading | form | done
  const [err, setErr] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setPhase("error");
      setErr("Falta el token de invitación en el enlace.");
      return;
    }
    apiFetch(`/auth/invitations/preview?token=${encodeURIComponent(token)}`)
      .then((data) => {
        setPreview(data);
        setPhase("form");
      })
      .catch((e) => {
        setErr(e.message);
        setPhase("error");
      });
  }, [token]);

  const strength = useMemo(() => passStrength(password), [password]);
  const strengthMeta = [
    { label: "Muy débil", cls: "bg-red-500", width: "20%" },
    { label: "Débil", cls: "bg-orange-500", width: "40%" },
    { label: "Aceptable", cls: "bg-amber-500", width: "60%" },
    { label: "Fuerte", cls: "bg-emerald-500", width: "80%" },
    { label: "Excelente", cls: "bg-emerald-400", width: "100%" },
  ][Math.max(strength - 1, 0)] || { label: "", cls: "", width: "0%" };

  const match = confirm.length > 0 && confirm === password;
  const canSubmit = password.length >= 8 && confirm === password && !busy;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr("");
    try {
      const data = await apiFetch("/auth/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      // Sesión inmediata: la persona ya está dentro, como en /register.
      localStorage.setItem("tf_token", data.access_token);
      setPhase("done");
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo size="lg" />
        </div>

        <div className="card p-6">
          {phase === "loading" && (
            <div className="space-y-3" aria-busy="true">
              <div className="skeleton h-5 w-2/3 mx-auto" />
              <div className="skeleton h-4 w-1/2 mx-auto" />
              <div className="skeleton h-9 w-full" />
              <div className="skeleton h-9 w-full" />
              <div className="skeleton h-10 w-full" />
            </div>
          )}

          {phase === "error" && (
            <div className="space-y-3 text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-red-500/15 text-red-400 ring-1 ring-red-500/30">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6" aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v4M12 16h.01" />
                </svg>
              </span>
              <h1 className="display text-lg">Enlace no válido</h1>
              <p className="text-sm text-zinc-400">{err}</p>
              <p className="text-xs text-zinc-600">
                Pide a tu negocio un enlace nuevo. Los enlaces expiran, se usan una sola vez y se pueden revocar.
              </p>
              <a href="/login" className="btn-ghost inline-block px-4 py-2 text-sm">
                Ir a iniciar sesión
              </a>
            </div>
          )}

          {phase === "form" && preview && (
            <>
              <p className="eyebrow">Invitación</p>
              <h1 className="display mt-0.5 text-xl">
                {preview.venue_name} te invita a su equipo
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-500/15 px-3 py-1 text-xs font-bold text-brand-300 ring-1 ring-brand-500/30">
                  {ROLE_LABEL[preview.role] || preview.role}
                </span>
                {preview.full_name && (
                  <span className="text-xs text-zinc-500">Para: {preview.full_name}</span>
                )}
                <span className="text-xs text-zinc-600">
                  Vence: {new Date(preview.expires_at).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>

              <form onSubmit={submit} className="mt-5 space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-400" htmlFor="inv-pass">
                    Crea tu contraseña
                  </label>
                  <input
                    id="inv-pass"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="field"
                    placeholder="Mínimo 8 caracteres"
                    minLength={8}
                    required
                    autoFocus
                  />
                  {password.length > 0 && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                        <div className={`h-full rounded-full transition-all ${strengthMeta.cls}`} style={{ width: strengthMeta.width }} />
                      </div>
                      <span className="text-2xs uppercase tracking-wide text-zinc-500">{strengthMeta.label}</span>
                    </div>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-zinc-400" htmlFor="inv-pass2">
                    Confírmala
                  </label>
                  <input
                    id="inv-pass2"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="field"
                    placeholder="Repite tu contraseña"
                    minLength={8}
                    required
                  />
                  {confirm.length > 0 && (
                    <p className={`mt-1 text-2xs ${match ? "text-emerald-400" : "text-red-400"}`}>
                      {match ? "✓ Coinciden" : "No coinciden todavía"}
                    </p>
                  )}
                </div>

                {err && <p className="text-xs text-red-400">{err}</p>}

                <button disabled={!canSubmit} className="btn-primary w-full">
                  {busy ? "Creando tu cuenta…" : "Crear mi cuenta y entrar"}
                </button>
                <p className="text-center text-2xs text-zinc-600">
                  Al entrar aceptas trabajar con los datos de {preview.venue_name}. ¿Dudas? Escríbele a quien te invitó.
                </p>
              </form>
            </>
          )}

          {phase === "done" && (
            <div className="space-y-3 text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6" aria-hidden>
                  <path d="m4 12.5 5 5L20 6.5" />
                </svg>
              </span>
              <h1 className="display text-lg">¡Listo, ya eres parte del equipo!</h1>
              <p className="text-sm text-zinc-400">Tu cuenta quedó creada con la contraseña que elegiste.</p>

              {/* Rol y destino: quién es y qué va a hacer desde ya */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-left">
                <p className="text-2xs font-bold uppercase tracking-wide text-zinc-500">
                  Entras como
                </p>
                <p className="display mt-0.5 text-base text-ink">
                  {ROLE_LABEL[preview?.role] || preview?.role} · {preview?.venue_name}
                </p>
                <p className="mt-1.5 text-sm text-zinc-400">
                  {ROLE_WELCOME[preview?.role] ||
                    "Tu cuenta ya tiene acceso: entra al panel para empezar."}
                </p>
              </div>

              <Link
                to={ROLE_HOME[preview?.role] || "/"}
                className="btn-primary inline-block px-5 py-2.5 text-sm font-bold"
              >
                Ir a mi panel
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
