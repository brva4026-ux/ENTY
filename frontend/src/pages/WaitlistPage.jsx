import { useCallback, useEffect, useRef, useState } from "react";
import {
  waitlistClaim,
  waitlistJoin,
  waitlistLeave,
  waitlistStatus,
} from "../lib/api";
import Icon from "../components/Icon";
import useDocumentTitle from "../lib/useDocumentTitle";

/**
 * Lista de espera del evento (E2, mig 022). Publica, sin cuentas: el fan
 * entra con nombre + telefono a un evento AGOTADO y recibe un enlace con su
 * credencial (token crudo, solo se muestra una vez). Si alguien devuelve una
 * boleta, el primero de la fila recibe una oferta con ventana corta; si no
 * reclama a tiempo, hereda al siguiente.
 *
 * La credencial viaja en el FRAGMENTO (#) como la boleta: nunca llega al
 * servidor en la URL y no queda en logs.
 */

const STORE_KEY = "tf_waitlist_token";

function readToken() {
  const raw = window.location.hash.replace(/^#/, "").trim();
  if (raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  // Sin fragmento, el localStorage puede guardar la credencial de OTRO evento:
  // mostrar "posicion 4" del evento equivocado es peor que pedir los datos
  // de nuevo. El enlace del mensaje (#) siempre manda.
  return null;
}

export default function WaitlistPage() {
  useDocumentTitle("Lista de espera");
  const [token, setToken] = useState(readToken);
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [joining, setJoining] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [eventId, setEventId] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [newTicket, setNewTicket] = useState(null);
  const pollRef = useRef(null);

  const refresh = useCallback(
    async (tok) => {
      const t = tok ?? token;
      if (!t) return;
      try {
        const d = await waitlistStatus(t);
        setState(d);
        setError("");
        setSecondsLeft(d.offer_seconds_left ?? null);
      } catch (e) {
        if (e.status === 404) {
          localStorage.removeItem(STORE_KEY);
          setToken(null);
        } else {
          setError(e.message);
        }
      }
    },
    [token],
  );

  // Polling: el fan no tiene push (sin cuentas), su pagina es su canal. El
  // polling de los interesados ademas alimenta el watchdog de expiracion.
  useEffect(() => {
    if (!token) return;
    refresh(token);
    pollRef.current = setInterval(() => refresh(token), 15000);
    return () => clearInterval(pollRef.current);
  }, [token, refresh]);

  // Countdown local de la oferta (suave, no sustituye al servidor).
  useEffect(() => {
    if (secondsLeft === null || state?.status !== "offered") return;
    const id = setInterval(
      () => setSecondsLeft((s) => (s === null ? null : Math.max(0, s - 1))),
      1000,
    );
    return () => clearInterval(id);
  }, [secondsLeft, state?.status]);

  async function doJoin(e) {
    e.preventDefault();
    setJoining(true);
    setError("");
    try {
      const d = await waitlistJoin(Number(eventId), name, phone);
      if (d.token) {
        localStorage.setItem(STORE_KEY, d.token);
        setToken(d.token);
      } else {
        // Re-join sin credencial nueva: el fan ya estaba en la fila pero
        // perdio su enlace. No puede recuperar el token (hash de una via),
        // pero su lugar esta a salvo con el telefono.
        setError(
          "Ya estabas en la fila pero no podemos mostrarte tu enlace (se entrega una sola vez). Tu lugar sigue a salvo.",
        );
        setJoining(false);
        return;
      }
      await refresh(d.token);
    } catch (e2) {
      setError(e2.message);
    } finally {
      setJoining(false);
    }
  }

  async function doClaim() {
    setLoading(true);
    setError("");
    try {
      const d = await waitlistClaim(token);
      setNewTicket(d);
      localStorage.removeItem(STORE_KEY);
      setState((s) => ({ ...s, status: "claimed" }));
    } catch (e) {
      setError(e.message);
      refresh();
    } finally {
      setLoading(false);
    }
  }

  async function doLeave() {
    setLoading(true);
    try {
      await waitlistLeave(token);
      localStorage.removeItem(STORE_KEY);
      setToken(null);
      setState(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ------------------------------------------------------------------ join
  if (!token) {
    return (
      <div className="relative min-h-screen bg-canvas px-4 py-8">
        <div className="relative mx-auto w-full max-w-sm animate-rise">
          <div className="card card-interactive p-5">
            <div className="mb-4 flex items-center gap-2">
              <span className="tile grid h-9 w-9">
                <Icon name="users" className="h-4 w-4 text-brand-400" />
              </span>
              <div>
                <p className="eyebrow">Lista de espera</p>
                <h1 className="text-sm font-bold text-ink">
                  Entra a la fila del evento
                </h1>
              </div>
            </div>

            {error && (
              <div className="mb-3 rounded-xl bg-red-500/10 p-3 text-center text-xs font-medium text-red-300 ring-1 ring-red-500/30">
                {error}
              </div>
            )}

            <form onSubmit={doJoin} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">
                  Tu nombre
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  minLength={2}
                  className="w-full rounded-xl bg-zinc-900 px-3 py-2.5 text-sm text-ink ring-1 ring-zinc-800 focus:ring-brand-500"
                  placeholder="Nombre y apellido"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">
                  Tu celular
                </label>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                  inputMode="tel"
                  className="tnum w-full rounded-xl bg-zinc-900 px-3 py-2.5 text-sm text-ink ring-1 ring-zinc-800 focus:ring-brand-500"
                  placeholder="300 000 0000"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">
                  Evento
                </label>
                <input
                  value={eventId}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setEventId(raw);
                    // Auto-detectar el id desde un enlace pegado
                    // (<origin>/waitlist#<id>): evita el error clasico de
                    // que la persona pegue el enlace completo y el join
                    // falle con "Evento no encontrado".
                    const m = raw.match(/waitlist#(\d+)/);
                    if (m) setEventId(m[1]);
                  }}
                  required
                  inputMode="numeric"
                  className="tnum w-full rounded-xl bg-zinc-900 px-3 py-2.5 text-sm text-ink ring-1 ring-zinc-800 focus:ring-brand-500"
                  placeholder="Link del evento o su número"
                />
                <p className="mt-1 text-2xs text-zinc-500">
                  El organizador comparte el enlace cuando el evento se agota.
                </p>
              </div>
              <button
                type="submit"
                disabled={joining}
                className="btn-primary w-full disabled:opacity-50"
              >
                {joining ? "Entrando…" : "Entrar a la fila"}
              </button>
            </form>
          </div>

          <p className="mt-4 text-center text-xs text-dim-2">
            Sin cuentas ni pagos por adelantado · Enty
          </p>
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------------- estado
  const offered = state?.status === "offered";

  return (
    <div className="relative min-h-screen bg-canvas px-4 py-8">
      <div className="relative mx-auto w-full max-w-sm animate-rise">
        <div className="card card-interactive p-5">
          <div className="mb-4 flex items-center gap-2">
            <span className="tile grid h-9 w-9">
              <Icon name="users" className="h-4 w-4 text-brand-400" />
              </span>
            <div className="min-w-0">
              <p className="eyebrow">Lista de espera</p>
              <h1 className="truncate text-sm font-bold text-ink">
                {state?.event_name ?? "Cargando…"}
              </h1>
            </div>
          </div>

          {error && (
            <div className="mb-3 rounded-xl bg-red-500/10 p-3 text-center text-xs font-medium text-red-300 ring-1 ring-red-500/30">
              {error}
            </div>
          )}

          {newTicket ? (
            <div className="rounded-xl bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
              <Icon
                name="check"
                className="mx-auto mb-2 h-6 w-6 text-emerald-400"
              />
              <p className="text-center text-sm font-bold text-emerald-300">
                ¡Tienes tu boleta!
              </p>
              <p className="mt-1 text-center text-xs leading-relaxed text-zinc-300">
                Guarda este enlace: es tu entrada y funciona una sola vez.
              </p>
              <p className="mt-3 break-all rounded-lg bg-zinc-900 p-2 text-center text-2xs text-zinc-300">
                {window.location.origin}/t#{newTicket.raw_token}
              </p>
              <a
                href={`/t#${newTicket.raw_token}`}
                className="btn-primary mt-3 w-full justify-center"
              >
                <Icon name="ticket" className="h-4 w-4" />
                Abrir mi boleta
              </a>
            </div>
          ) : offered ? (
            <div className="rounded-xl bg-brand-500/10 p-4 ring-1 ring-brand-500/30">
              <p className="text-center text-sm font-bold text-brand-300">
                ¡Se liberó un lugar para ti!
              </p>
              <p className="mt-1 text-center text-xs text-zinc-300">
                Tienes hasta las{" "}
                <span className="tnum font-bold">{state.offer_expires_at}</span>{" "}
                para reclamarlo
                {secondsLeft !== null && (
                  <>
                    {" · "}
                    <span className="tnum font-bold text-ink">
                      {Math.floor(secondsLeft / 60)}:
                      {String(secondsLeft % 60).padStart(2, "0")}
                    </span>
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={doClaim}
                disabled={loading || secondsLeft === 0}
                className="btn-primary mt-3 w-full disabled:opacity-50"
              >
                {loading
                  ? "Reclamando…"
                  : secondsLeft === 0
                    ? "La ventana cerró"
                    : "Reclamar mi lugar"}
              </button>
              {secondsLeft === 0 && (
                <p className="mt-2 text-center text-2xs text-zinc-500">
                  Si no alcanzaste, el lugar pasó al siguiente de la fila.
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-2xl bg-zinc-900/60 p-6 text-center ring-1 ring-zinc-800">
              <span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-brand-500/15">
                <Icon name="clock" className="h-7 w-7 text-brand-300" />
              </span>
              {state?.status === "claimed" ? (
                <p className="text-sm font-bold text-ink">
                  Ya reclamaste tu lugar
                </p>
              ) : state?.status === "left" ? (
                <>
                  <p className="text-sm font-bold text-ink">Saliste de la fila</p>
                  <p className="mt-1 text-xs text-zinc-400">
                    Puedes volver a entrar mientras el evento siga agotado.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      localStorage.removeItem(STORE_KEY);
                      setToken(null);
                    }}
                    className="btn-primary mt-3 w-full"
                  >
                    Volver a entrar
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm font-bold text-ink">
                    Vas en la posición{" "}
                    <span className="tnum text-brand-300">
                      #{state?.position ?? "…"}
                    </span>
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                    Te avisamos aquí cuando se libere un lugar. Deja esta
                    página guardada y revisa tu turno.
                  </p>
                </>
              )}
            </div>
          )}

          {state && !newTicket && (
            <div className="mt-4 space-y-1 rounded-xl bg-zinc-900/60 p-3 ring-1 ring-zinc-800">
              <p className="text-xs font-bold text-ink">{state.venue_name}</p>
              <p className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Icon name="clock" className="h-3.5 w-3.5" />
                {state.starts_at}
              </p>
            </div>
          )}

          {state?.status === "waiting" && (
            <button
              type="button"
              onClick={doLeave}
              disabled={loading}
              className="btn-danger-text mt-2 w-full justify-center"
            >
              Salir de la fila
            </button>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-dim-2">
          Tu lugar es personal: se valida por tu celular · Enty
        </p>
      </div>
    </div>
  );
}
