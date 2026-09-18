import { useCallback, useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { LiveIndicator } from "../components/Brand";
import { PushToggle } from "../components/PushToggle";

function firstVenueId(user) {
  const ids = Object.keys(user?.roles || {}).map(Number);
  return ids[0] ?? null;
}

const RESULT_STYLES = {
  GRANTED: { bg: "bg-emerald-600", text: "ENTRA", icon: "✓", sub: "Boleta válida" },
  ALREADY_REDEEMED: { bg: "bg-red-600", text: "YA USADA", icon: "✗", sub: "Presentada anteriormente" },
  NOT_FOUND: { bg: "bg-red-600", text: "NO EXISTE", icon: "✗", sub: "Código inválido" },
  INVALID_EVENT: { bg: "bg-zinc-700", text: "OTRO EVENTO", icon: "!", sub: "Boleta de otra fiesta" },
  EVENT_NOT_LIVE: { bg: "bg-zinc-700", text: "EVENTO CERRADO", icon: "!", sub: "La puerta no está abierta" },
  NOT_VALID: { bg: "bg-red-600", text: "ANULADA", icon: "✗", sub: "Boleta revocada" },
  // Boleta válida del evento pero de otra fila: no entra y NO se consume
  // (puede entrar por la fila correcta). El detalle dice de qué fila era.
  WRONG_TYPE: { bg: "bg-amber-600", text: "FILA EQUIVOCADA", icon: "!", sub: "" },
  NETWORK_ERROR: { bg: "bg-amber-600", text: "SIN RED", icon: "!", sub: "Revisa tu conexión" },
  // Error HTTP con mensaje del servidor (p.ej. el evento fue borrado mientras
  // el portero lo tenía seleccionado): se muestra el detalle real.
  SCAN_ERROR: { bg: "bg-amber-600", text: "ERROR", icon: "!", sub: "" },
};

// ms que dura el resultado en pantalla antes de volver a escanear
const RESULT_RESET_MS = 4000;

export default function BouncerScanner() {
  const { user, logout } = useAuth();
  const venueId = firstVenueId(user);

  const [events, setEvents] = useState(null); // null = primera carga (skeleton)
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [manualCode, setManualCode] = useState("");
  // Filtro de fila (v1.1): cuando la venue tiene varias entradas (VIP,
  // general…), cada teléfono puede quedar asignado a UNA fila. Vacío =
  // aceptar boletas de cualquier tipo (comportamiento clásico).
  const [types, setTypes] = useState([]);
  const [rowFilter, setRowFilter] = useState("");
  const scannerRef = useRef(null);
  const html5Ref = useRef(null);
  const lastScannedRef = useRef("");
  const resetTimerRef = useRef(null);

  // Lista de eventos: carga inicial + refresco periódico. El bouncer abre la
  // app antes de que arranque la fiesta; si el admin "abre puertas" o crea el
  // evento mientras tanto, el selector se actualiza sin recargar. Solo se
  // auto-selecciona el primero la PRIMERA vez: nunca se cambia el evento en
  // pleno turno por una recarga de fondo.
  const loadEvents = useCallback(async () => {
    if (!venueId) return;
    try {
      const data = await apiFetch(`/venues/${venueId}/events`);
      setEvents(data);
      setSelectedEvent((prev) => prev ?? (data.length ? data[0].id : null));
    } catch (e) {
      setError(e.message);
      setEvents((prev) => prev ?? []); // null = cargando; un fallo no es "cargando"
    }
  }, [venueId]);

  useEffect(() => {
    loadEvents();
    return () => {
      stopScanner();
    };
  }, [loadEvents]);

  const lastEventsUpdate = useLiveRefresh(loadEvents, true, 20_000);

  // Tipos del evento seleccionado: alimentan el filtro de fila. Si el
  // endpoint falla o no hay tipos, el filtro queda vacío y el escaneo
  // funciona igual (es opcional, nunca bloquea la puerta).
  const loadTypes = useCallback(async () => {
    if (!venueId || !selectedEvent) {
      setTypes([]);
      return;
    }
    try {
      const data = await apiFetch(`/venues/${venueId}/events/${selectedEvent}/types`);
      setTypes(data.filter((t) => t.is_active !== false));
    } catch {
      setTypes([]);
    }
  }, [venueId, selectedEvent]);

  useEffect(() => {
    loadTypes();
    // Cambiar de evento resetea la fila: un filtro del evento anterior no
    // debe aplicar silenciosamente al siguiente.
    setRowFilter("");
  }, [loadTypes]);

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
        // Con fila asignada, el servidor rechaza boletas de otro tipo con
        // code=WRONG_TYPE (sin consumirlas). Sin filtro se omite el campo.
        body: JSON.stringify({
          raw_token: rawToken,
          ...(rowFilter ? { ticket_type_id: rowFilter } : {}),
        }),
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
      // Un error HTTP trae semántica de negocio desde el servidor (err.status
      // + mensaje accionable); solo la falta de conexión es "sin red".
      setResult(
        err.status
          ? { code: "SCAN_ERROR", detail: err.message }
          : { code: "NETWORK_ERROR", detail: err.message },
      );
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
    <div className="flex min-h-[100dvh] flex-col bg-zinc-950 pb-[env(safe-area-inset-bottom)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-white">Control de puerta</h1>
          <p className="text-xs text-zinc-500">{user?.full_name}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-flex">
            <LiveIndicator lastUpdated={lastEventsUpdate} live={false} />
          </span>
          <select
            value={selectedEvent ?? ""}
            onChange={(e) => setSelectedEvent(Number(e.target.value))}
            className="max-w-[52vw] rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-white sm:max-w-none"
          >
            <option value="" disabled>Evento…</option>
            {events === null
              ? null // el select se renderiza vacío un instante; el error global cubre fallos
              : events.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.name}</option>
              ))}
          </select>
          <button
            onClick={logout}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800"
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
          <span className="animate-pop text-8xl font-black text-white drop-shadow-lg">{style.icon}</span>
          <span className="animate-scale-in mt-4 text-5xl font-black uppercase tracking-tight text-white">
            {style.text}
          </span>
          <span className="animate-fade mt-2 text-lg font-semibold text-white/90">
            {(result?.code === "SCAN_ERROR" || result?.code === "WRONG_TYPE") && result.detail
              ? result.detail
              : style.sub}
          </span>
          {result?.customer_name && (
            <span className="animate-pop mt-5 rounded-full bg-black/30 px-5 py-1.5 text-2xl font-semibold text-white">
              {result.customer_name}
            </span>
          )}
          <span className="absolute bottom-8 text-sm font-medium text-white/70">
            Toca para escanear otro
          </span>
        </button>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center p-4">
          <div id="qr-reader-region" className="w-full max-w-sm overflow-hidden rounded-2xl ring-1 ring-zinc-800" />
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
          <form onSubmit={submitManual} className="mt-5 flex w-full max-w-sm items-center gap-2">
            <input
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="O escribe el código de la boleta"
              autoComplete="off"
              spellCheck={false}
              className="field min-w-0 flex-1"
            />
            <button type="submit" className="btn-ghost shrink-0 font-bold">
              Validar
            </button>
          </form>

          {/* Filtro de fila: chips horizontales (scroll en pantallas chicas).
              Activo = blanco, igual que el patrón de chips del admin. */}
          {types.length > 0 && (
            <div className="no-scrollbar mt-3 w-full max-w-sm overflow-x-auto">
              <div className="flex w-max items-center gap-1.5">
                <button
                  onClick={() => setRowFilter("")}
                  aria-pressed={rowFilter === ""}
                  className={`chip rounded-full px-3 py-1.5 text-xs font-semibold ${
                    rowFilter === "" ? "chip-active" : "bg-zinc-800/70 text-zinc-300"
                  }`}
                >
                  Todas las filas
                </button>
                {types.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setRowFilter(t.id)}
                    aria-pressed={rowFilter === t.id}
                    className={`chip rounded-full px-3 py-1.5 text-xs font-semibold ${
                      rowFilter === t.id ? "chip-active" : "bg-zinc-800/70 text-zinc-300"
                    }`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="mt-4 max-w-sm text-center text-xs text-zinc-600">
            Verde = entra · Rojo = no entra. El resultado también aparece con el código manual.
          </p>

          {/* Aviso push cuando el admin abra puertas (published -> live) */}
          <div className="w-full max-w-sm">
            <PushToggle venueId={venueId} />
          </div>
        </div>
      )}
    </div>
  );
}
