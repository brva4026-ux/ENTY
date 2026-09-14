import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

function firstVenueId(user) {
  const ids = Object.keys(user?.roles || {}).map(Number);
  return ids[0] ?? null;
}

const RESULT_STYLES = {
  GRANTED: { bg: "bg-emerald-500", text: "ENTRA", icon: "✓", sub: "Boleta válida" },
  ALREADY_REDEEMED: { bg: "bg-red-500", text: "YA USADA", icon: "✗", sub: "Presentada anteriormente" },
  NOT_FOUND: { bg: "bg-red-500", text: "NO EXISTE", icon: "✗", sub: "Código inválido" },
  INVALID_EVENT: { bg: "bg-slate-600", text: "OTRO EVENTO", icon: "!", sub: "Boleta de otra fiesta" },
  EVENT_NOT_LIVE: { bg: "bg-slate-600", text: "EVENTO CERRADO", icon: "!", sub: "La puerta no está abierta" },
  NOT_VALID: { bg: "bg-red-500", text: "ANULADA", icon: "✗", sub: "Boleta revocada" },
  NETWORK_ERROR: { bg: "bg-amber-500", text: "SIN RED", icon: "!", sub: "Revisa tu conexión" },
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
      // vibración háptica: verde = pulso corto, rojo = doble pulso
      if (navigator.vibrate) {
        navigator.vibrate(data.redeemed ? [80] : [60, 60, 60]);
      }
      // auto-reset para volver a escanear sin tocar nada
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(resetScan, RESULT_RESET_MS);
    } catch (err) {
      setResult({ code: "NETWORK_ERROR", detail: err.message });
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

  return (
    <div className="flex h-screen flex-col bg-slate-950">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div>
          <h1 className="text-lg font-black tracking-tight text-white">Control de puerta</h1>
          <p className="text-xs text-slate-500">{user?.full_name}</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedEvent ?? ""}
            onChange={(e) => setSelectedEvent(Number(e.target.value))}
            className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-white"
          >
            <option value="" disabled>Evento…</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>{ev.name}</option>
            ))}
          </select>
          <button
            onClick={logout}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
          >
            Salir
          </button>
        </div>
      </header>

      {/* Resultado a pantalla completa (semántica: verde entra, rojo no) */}
      {style ? (
        <button
          onClick={resetScan}
          className={`flex flex-1 flex-col items-center justify-center ${style.bg} p-6 transition-colors`}
        >
          <span className="animate-rise text-8xl font-black text-white drop-shadow-lg">{style.icon}</span>
          <span className="animate-rise mt-4 text-5xl font-black uppercase tracking-tight text-white">
            {style.text}
          </span>
          <span className="mt-2 text-lg font-semibold text-white/90">{style.sub}</span>
          {result?.customer_name && (
            <span className="animate-rise mt-5 rounded-full bg-black/25 px-5 py-1.5 text-2xl font-bold text-white">
              {result.customer_name}
            </span>
          )}
          <span className="absolute bottom-8 text-sm font-medium text-white/70">
            Toca para escanear otro
          </span>
        </button>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center p-4">
          <div id="qr-reader-region" className="w-full max-w-sm overflow-hidden rounded-2xl ring-1 ring-slate-800" />
          {!scanning && (
            <button onClick={startScanner} className="btn-primary mt-4 w-full max-w-sm !py-4 !text-lg">
              Activar cámara
            </button>
          )}
          {scanning && (
            <button onClick={stopScanner} className="btn-ghost mt-4">
              Detener escaneo
            </button>
          )}

          {error && <p className="mt-3 max-w-sm text-center text-sm text-red-400">{error}</p>}

          {/* Respaldo manual: cámara rota, permisos denegados, QR dañado */}
          <form onSubmit={submitManual} className="mt-5 flex w-full max-w-sm gap-2">
            <input
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="O escribe el código de la boleta"
              autoComplete="off"
              spellCheck={false}
              className="field"
            />
            <button type="submit" className="btn-ghost shrink-0 font-bold">
              Validar
            </button>
          </form>

          <p className="mt-4 max-w-sm text-center text-xs text-slate-600">
            Verde = entra · Rojo = no entra. El resultado también aparece con el código manual.
          </p>
        </div>
      )}
    </div>
  );
}
