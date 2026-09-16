import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import Icon from "../components/Icon";
import { Logo } from "../components/Brand";
import { clockTime } from "../lib/format";

function firstVenueId(user) {
  const ids = Object.keys(user?.roles || {}).map(Number);
  return ids[0] ?? null;
}

/* El veredicto es lo unico que el bouncer mira: por eso el color es plano y
   saturado (se lee a un metro, con el celular en la mano y poca luz), el
   icono es enorme y el texto va en dos niveles (veredicto + motivo). */
const RESULT_STYLES = {
  GRANTED: {
    bg: "bg-emerald-500",
    glow: "shadow-[0_0_120px_-20px_rgba(16,185,129,0.9)]",
    text: "ENTRA",
    icon: "check",
    sub: "Boleta válida",
  },
  ALREADY_REDEEMED: {
    bg: "bg-red-500",
    glow: "shadow-[0_0_120px_-20px_rgba(239,68,68,0.9)]",
    text: "YA USADA",
    icon: "close",
    sub: "Presentada anteriormente",
  },
  NOT_FOUND: {
    bg: "bg-red-500",
    glow: "shadow-[0_0_120px_-20px_rgba(239,68,68,0.9)]",
    text: "NO EXISTE",
    icon: "close",
    sub: "Código inválido",
  },
  INVALID_EVENT: {
    bg: "bg-slate-600",
    glow: "shadow-[0_0_120px_-20px_rgba(71,85,105,0.9)]",
    text: "OTRO EVENTO",
    icon: "alert",
    sub: "Boleta de otra fiesta",
  },
  EVENT_NOT_LIVE: {
    bg: "bg-slate-600",
    glow: "shadow-[0_0_120px_-20px_rgba(71,85,105,0.9)]",
    text: "EVENTO CERRADO",
    icon: "alert",
    sub: "La puerta no está abierta",
  },
  NOT_VALID: {
    bg: "bg-red-500",
    glow: "shadow-[0_0_120px_-20px_rgba(239,68,68,0.9)]",
    text: "ANULADA",
    icon: "close",
    sub: "Boleta revocada",
  },
  NETWORK_ERROR: {
    bg: "bg-amber-500",
    glow: "shadow-[0_0_120px_-20px_rgba(245,158,11,0.9)]",
    text: "SIN RED",
    icon: "alert",
    sub: "Revisa tu conexión",
  },
};

// ms que dura el resultado en pantalla antes de volver a escanear
const RESULT_RESET_MS = 4000;

export default function BouncerScanner() {
  const { user, logout } = useAuth();
  const venueId = firstVenueId(user);

  const [events, setEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [manualCode, setManualCode] = useState("");
  // Contador de la sesion: el bouncer ve que su trabajo avanza sin mirar el panel.
  const [tally, setTally] = useState({ ok: 0, bad: 0 });
  const [lastAt, setLastAt] = useState(null);
  const scannerRef = useRef(null);
  const html5Ref = useRef(null);
  const lastScannedRef = useRef("");
  const resetTimerRef = useRef(null);

  useEffect(() => {
    if (!venueId) return;
    apiFetch(`/venues/${venueId}/events`)
      .then((data) => {
        setEvents(data);
        if (data.length) setSelectedEvent(data[0].id);
      })
      .catch((e) => setError(e.message));

    return () => {
      stopScanner();
    };
  }, [venueId]);

  // limpieza del timer al desmontar
  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  async function startScanner() {
    setError("");
    setResult(null);
    if (!selectedEvent) {
      setError("Selecciona un evento primero");
      return;
    }
    try {
      const qr = new Html5Qrcode("qr-reader-region");
      html5Ref.current = qr;
      await qr.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        onScanSuccess,
        () => {}
      );
      setScanning(true);
    } catch (err) {
      setError("No se pudo iniciar la cámara: " + (err?.message || err));
    }
  }

  async function stopScanner() {
    if (html5Ref.current) {
      try {
        await html5Ref.current.stop();
        await html5Ref.current.clear();
      } catch {
        /* ignore */
      }
      html5Ref.current = null;
    }
    setScanning(false);
  }

  async function redeemToken(rawToken, { manual = false } = {}) {
    if (!selectedEvent) {
      setError("Selecciona un evento primero");
      return;
    }
    // ignora lecturas repetidas del mismo código (bouncer apunta al mismo QR);
    // la entrada manual siempre se envía porque fue un submit explícito
    if (!manual && rawToken === lastScannedRef.current) return;
    lastScannedRef.current = rawToken;
    try {
      const data = await apiFetch(`/venues/${venueId}/events/${selectedEvent}/redeem`, {
        method: "POST",
        body: JSON.stringify({ raw_token: rawToken }),
      });
      setResult(data);
      setLastAt(Date.now());
      setTally((t) =>
        data.redeemed ? { ...t, ok: t.ok + 1 } : { ...t, bad: t.bad + 1 }
      );
      // vibración háptica: verde = pulso corto, rojo = doble pulso
      if (navigator.vibrate) {
        navigator.vibrate(data.redeemed ? [80] : [60, 60, 60]);
      }
      // auto-reset para volver a escanear sin tocar nada
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(resetScan, RESULT_RESET_MS);
    } catch (err) {
      setResult({ code: "NETWORK_ERROR", detail: err.message });
      setLastAt(Date.now());
      setTally((t) => ({ ...t, bad: t.bad + 1 }));
    }
  }

  async function onScanSuccess(decodedText) {
    await redeemToken(decodedText);
  }

  async function submitManual(e) {
    e.preventDefault();
    const token = manualCode.trim();
    if (token.length < 8) {
      setError("El código es demasiado corto");
      return;
    }
    setError("");
    setManualCode("");
    await redeemToken(token, { manual: true });
  }

  function resetScan() {
    setResult(null);
    lastScannedRef.current = "";
  }

  const style = result ? RESULT_STYLES[result.code] ?? RESULT_STYLES.NOT_FOUND : null;
  const eventName = events.find((ev) => ev.id === selectedEvent)?.name;

  return (
    <div className="grain relative flex h-screen flex-col overflow-hidden bg-slate-950">
      <div className="atmosphere" aria-hidden="true" />

      <header className="relative z-20 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Logo />
            <div className="hidden min-w-0 border-l border-slate-800 pl-3 sm:block">
              <p className="truncate text-sm font-bold text-white">Control de puerta</p>
              <p className="truncate text-xs text-slate-500">{user?.full_name}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectedEvent ?? ""}
              onChange={(e) => setSelectedEvent(Number(e.target.value))}
              aria-label="Evento en puerta"
              className="field !w-auto max-w-[11rem] shrink-0 !py-1.5 text-xs font-semibold"
            >
              <option value="" disabled>Evento…</option>
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.name}</option>
              ))}
            </select>
            <button
              onClick={logout}
              className="btn-ghost tap-target !px-3"
              aria-label="Salir"
            >
              <Icon name="logout" className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Marcador de la sesion: dos cifras, sin graficos. */}
        <div className="flex items-stretch divide-x divide-slate-800/80 border-t border-slate-800/60">
          <Tally label="Aceptadas" value={tally.ok} dot="bg-emerald-400" />
          <Tally label="Rechazadas" value={tally.bad} dot="bg-red-400" />
        </div>
      </header>

      {/* Resultado a pantalla completa (semántica: verde entra, rojo no) */}
      {style ? (
        <button
          onClick={resetScan}
          className={`animate-verdict relative z-10 flex flex-1 flex-col items-center justify-center ${style.bg} ${style.glow} p-6`}
        >
          <span className="grid h-28 w-28 place-items-center rounded-full bg-black/20 ring-1 ring-white/25">
            <Icon name={style.icon} className="h-16 w-16 text-white" strokeWidth={2.5} />
          </span>
          <span className="mt-6 text-center font-display text-5xl font-extrabold uppercase leading-none tracking-tight text-white drop-shadow-lg sm:text-6xl">
            {style.text}
          </span>
          <span className="mt-3 text-lg font-semibold text-white/90">{style.sub}</span>

          {result?.customer_name && (
            <span className="mt-6 max-w-full truncate rounded-full bg-black/25 px-6 py-2 text-2xl font-bold text-white ring-1 ring-white/15">
              {result.customer_name}
            </span>
          )}

          {lastAt && (
            <span className="tnum mt-4 font-mono text-xs font-medium text-white/60">
              {clockTime(new Date(lastAt).toISOString())}
            </span>
          )}

          <span className="absolute bottom-7 flex items-center gap-2 text-sm font-medium text-white/70">
            <Icon name="camera" className="h-4 w-4" />
            Toca para escanear otro
          </span>
        </button>
      ) : (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center overflow-y-auto p-4">
          {/* Visor: el marco y la linea de barrido hacen visible que la camara
              esta buscando, en vez de mostrar un rectangulo vacio. */}
          <div className="relative w-full max-w-sm">
            <div
              id="qr-reader-region"
              className="w-full overflow-hidden rounded-2xl bg-slate-900/80 ring-1 ring-slate-800"
            />
            {!scanning && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <div className="grid h-20 w-20 place-items-center rounded-2xl bg-slate-800/60 ring-1 ring-slate-700/60">
                  <Icon name="qr" className="h-10 w-10 text-slate-500" />
                </div>
              </div>
            )}
            {scanning && (
              <div aria-hidden className="pointer-events-none absolute inset-0">
                <span className="viewfinder-corner viewfinder-tl" />
                <span className="viewfinder-corner viewfinder-tr" />
                <span className="viewfinder-corner viewfinder-bl" />
                <span className="viewfinder-corner viewfinder-br" />
                <span className="viewfinder-sweep" />
              </div>
            )}
          </div>

          {eventName && (
            <p className="mt-4 flex items-center gap-2 text-xs text-slate-500">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />
              Escaneando para <span className="font-semibold text-slate-300">{eventName}</span>
            </p>
          )}

          {!scanning ? (
            <button onClick={startScanner} className="btn-primary mt-4 w-full max-w-sm !py-4 !text-base">
              <Icon name="camera" className="h-5 w-5" />
              Activar cámara
            </button>
          ) : (
            <button onClick={stopScanner} className="btn-ghost tap-target mt-4">
              Detener escaneo
            </button>
          )}

          {error && (
            <p className="mt-3 flex max-w-sm items-center gap-2 text-center text-sm text-red-400">
              <Icon name="alert" className="h-4 w-4 shrink-0" />
              {error}
            </p>
          )}

          {/* Respaldo manual: cámara rota, permisos denegados, QR dañado */}
          <form onSubmit={submitManual} className="mt-6 w-full max-w-sm">
            <label className="eyebrow mb-1.5 block text-center">
              O valida con el código
            </label>
            <div className="flex gap-2">
              <input
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder="Código de la boleta"
                autoComplete="off"
                spellCheck={false}
                className="field font-mono text-xs"
              />
              <button type="submit" className="btn-ghost tap-target shrink-0 font-bold">
                Validar
              </button>
            </div>
          </form>

          <p className="mt-5 flex max-w-sm items-center gap-2 text-center text-xs text-slate-600">
            <Icon name="bolt" className="h-3.5 w-3.5 shrink-0 text-emerald-500/70" />
            Verde entra · rojo no entra. Todo queda registrado para el reporte.
          </p>
        </div>
      )}
    </div>
  );
}

/** Celda del marcador de sesion. */
function Tally({ label, value, dot }) {
  return (
    <div className="flex-1 px-4 py-2">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {label}
      </p>
      <p className="tnum font-display text-xl font-extrabold leading-tight text-white">
        {value}
      </p>
    </div>
  );
}
