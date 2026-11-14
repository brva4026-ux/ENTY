import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { haptics } from "../lib/haptics";
import { Logo } from "../components/Brand";
import { AuthBackdrop } from "../components/AuthBackdrop";
import Icon from "../components/Icon";

/**
 * /puerta?token=… — el link que el admin le manda a quien abre la puerta.
 *
 * La diferencia con /escaner: acá la NOCHE YA ESTÁ FIJA. El link lleva el
 * evento adentro, así que esta pantalla no pregunta nada: mira a qué noche
 * entra, lo canjea y manda directo al escáner de ESA noche. Si el token
 * pertenece a otra persona, venció o ya se usó, lo dice con palabras y no
 * deja abrir un selector que alguien usaría para adivinar la fecha.
 *
 * El token viaja en la QUERY (?token=) porque es el unico canal de este
 * link (a diferencia del QR de la boleta, que usa el fragmento para no
 * dejarlo en logs). Es de un solo uso: apenas se canjea, muere.
 */
export default function DoorLinkPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const token = params.get("token") || "";

  const [preview, setPreview] = useState(null); // null = mirando
  const [error, setError] = useState("");
  const [entrando, setEntrando] = useState(false);

  const mirar = useCallback(async () => {
    setError("");
    try {
      const data = await apiFetch(`/escaner/acceso?token=${encodeURIComponent(token)}`);
      setPreview(data);
    } catch (e) {
      setPreview(null);
      setError(e.message);
    }
  }, [token]);

  useEffect(() => {
    if (token) mirar();
    else setError("Ese link no trae ningún acceso.");
  }, [token, mirar]);

  async function entrar() {
    setEntrando(true);
    setError("");
    try {
      const r = await apiFetch(
        `/escaner/acceso?token=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      haptics.success();
      // El evento queda atado a esta persona: el escaner abre en su noche.
      nav(`/bouncer?evento=${r.event_id}`, { replace: true });
    } catch (e) {
      setError(e.message);
      setPreview(null);
      setEntrando(false);
    }
  }

  // Sin sesión no hay nada que canjear: el link es una credencial atada a una
  // persona, no un atajo para entrar sin cuenta.
  if (!user) {
    return (
      <div className="app-shell relative flex min-h-screen items-center justify-center overflow-hidden p-4">
        <AuthBackdrop />
        <div className="relative w-full max-w-sm">
          <div className="card p-6 text-center">
            <Logo />
            <h1 className="display mt-4 text-lg">Inicia sesión</h1>
            <p className="mt-2 text-sm text-zinc-500">
              Este link es personal: entra con la cuenta que el admin asignó a
              esta noche y volvé a abrirlo.
            </p>
            <button
              onClick={() => nav("/login")}
              className="btn-primary mt-5 w-full"
            >
              Ir al inicio de sesión
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      <AuthBackdrop />
      <div className="relative w-full max-w-sm">
        <div className="card p-6">
          <Logo />
          {!token || error ? (
            <>
              <h1 className="display mt-4 text-lg">Este link no sirve</h1>
              <p className="mt-2 text-sm text-zinc-400">{error}</p>
              <p className="mt-4 rounded-lg bg-zinc-940 px-3 py-2 text-xs text-zinc-500">
                Los links de puerta son de un solo uso y vencen. Pedile uno
                nuevo al admin del bar.
              </p>
            </>
          ) : !preview ? (
            <div className="mt-4 space-y-3">
              <div className="skeleton h-5 w-40" />
              <div className="skeleton h-4 w-full" />
              <div className="skeleton h-11 w-full" />
            </div>
          ) : (
            <>
              <p className="mt-4 text-xs text-zinc-500">
                Este link sirve solo para entrar a esa noche, con tu cuenta. Si no
                tienes cámara o no puedes generar el QR en el escáner, pide el
                código manual al administrador y entra por la pantalla de puerta.
              </p>
              <h1 className="display mt-0.5 text-xl">{preview.event_name}</h1>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-zinc-400">
                <Icon name="calendar" className="h-3.5 w-3.5" />
                {new Date(preview.starts_at).toLocaleString("es-CO", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
              <p className="mt-3 rounded-lg bg-zinc-940 px-3 py-2 text-xs text-zinc-400">
                Sos <strong className="text-zinc-200">{preview.full_name}</strong>.
                Entrás directo a esta noche: no vas a tener que elegirla.
              </p>
              {preview.used && (
                <p className="mt-2 text-xs text-amber-400">
                  Este link ya se usó. Si perdiste el teléfono, pide uno nuevo.
                </p>
              )}
              <button
                onClick={entrar}
                disabled={entrando || preview.used}
                className="btn-primary mt-5 w-full"
              >
                {entrando ? "Abriendo…" : "Entrar a la puerta"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
