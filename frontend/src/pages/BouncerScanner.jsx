import { useCallback, useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { apiFetch } from "../lib/api";
import { activeVenueId } from "../lib/venue";
import { playForCode, playOffline } from "../lib/doorSounds";
import {
  requestWakeLock,
  releaseWakeLock,
  autoReacquireWakeLock,
} from "../lib/wakeLock";
import { useAuth } from "../lib/auth";
import { forceDarkOnce } from "../lib/theme";
import { haptics } from "../lib/haptics";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { LiveIndicator } from "../components/Brand";
import { PushToggle } from "../components/PushToggle";

function firstVenueId(user) {
  return activeVenueId(user);
}

const RESULT_STYLES = {
  GRANTED: {
    bg: "bg-emerald-600",
    text: "ENTRA",
    icon: "✓",
    sub: "Boleta válida",
  },
  ALREADY_REDEEMED: {
    bg: "bg-red-600",
    text: "YA USADA",
    icon: "✗",
    sub: "Presentada anteriormente",
  },
  NOT_FOUND: {
    bg: "bg-red-600",
    text: "NO EXISTE",
    icon: "✗",
    sub: "Código inválido",
  },
  INVALID_EVENT: {
    bg: "bg-zinc-700",
    text: "OTRO EVENTO",
    icon: "!",
    sub: "Boleta de otra fiesta",
  },
  EVENT_NOT_LIVE: {
    bg: "bg-zinc-700",
    text: "EVENTO CERRADO",
    icon: "!",
    sub: "La puerta no está abierta",
  },
  NOT_VALID: {
    bg: "bg-red-600",
    text: "ANULADA",
    icon: "✗",
    sub: "Boleta revocada",
  },
  // Boleta válida del evento pero de otra fila: no entra y NO se consume
  // (puede entrar por la fila correcta). El detalle dice de qué fila era.
  WRONG_TYPE: {
    bg: "bg-amber-600",
    text: "FILA EQUIVOCADA",
    icon: "!",
    sub: "",
  },
  NETWORK_ERROR: {
    bg: "bg-amber-600",
    text: "SIN RED",
    icon: "!",
    sub: "Revisa tu conexión",
  },
  // Error HTTP con mensaje del servidor (p.ej. el evento fue borrado mientras
  // el portero lo tenía seleccionado): se muestra el detalle real.
  SCAN_ERROR: { bg: "bg-amber-600", text: "ERROR", icon: "!", sub: "" },
  // Mig 013: boleta VÁLIDA cuya ventana de activación aún no abrió. Ámbar
  // (no rojo: no es fraude, es temprano). El detalle trae la hora exacta.
  NOT_ACTIVE: {
    bg: "bg-amber-600",
    text: "AÚN NO ACTIVA",
    icon: "⏳",
    sub: "",
  },
};

// ms que dura el resultado en pantalla antes de volver a escanear
const RESULT_RESET_MS = 4000;

// Etiquetas del log local (cortas: la fila se lee de un vistazo en la puerta).
const SCAN_LOG_LABEL = {
  GRANTED: "ENTRA",
  ALREADY_REDEEMED: "YA USADA",
  NOT_FOUND: "NO EXISTE",
  INVALID_EVENT: "OTRO EVENTO",
  EVENT_NOT_LIVE: "EVENTO CERRADO",
  NOT_VALID: "ANULADA",
  WRONG_TYPE: "FILA EQUIVOCADA",
  NETWORK_ERROR: "SIN RED",
  SCAN_ERROR: "ERROR",
  NOT_ACTIVE: "AÚN NO ACTIVA",
};
// Anti-spam de reintentos de NOT_ACTIVE: el servidor no cobra por cada
// escaneo, pero martillar no cambia la hora del evento.
const RETRY_COOLDOWN_MS = 20_000;

// Modo kiosco: ms que hay que MANTENER presionado "Salir" para desbloquear.
// Un toque accidental (bolsillo, roce, niño curioso) no saca a nadie del
// escáner en plena fila — el patrón de los puntos de venta.
const EXIT_HOLD_MS = 1500;

export default function BouncerScanner() {
  const { user, logout } = useAuth();
  const venueId = firstVenueId(user);

  // La puerta SIEMPRE oscura: en un recinto a oscuras un flash de fondo
  // blanco ciega al portero. forceDarkOnce pone el candado y devuelve el
  // restaurador que se ejecuta al desmontar (sale el tema del usuario).
  useEffect(() => {
    const restore = forceDarkOnce();
    return restore;
  }, []);

  const [events, setEvents] = useState(null); // null = primera carga (skeleton)
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [scanning, setScanning] = useState(false);
  // La cámara está EN preparar (permiso + hardware): el botón dice lo que pasa
  // y no parece un cuelgue en móviles lentos, donde puede tardar segundos.
  const [starting, setStarting] = useState(false);
  // Petición de canje en vuelo: la retícula cambia a "validando" (anillo).
  const [validating, setValidating] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [manualCode, setManualCode] = useState("");
  // Reintento de NOT_ACTIVE: token esperando y disponibilidad del reintento.
  const [pendingRetry, setPendingRetry] = useState(null); // raw_token
  const [retryIn, setRetryIn] = useState(0); // segundos restantes de cooldown
  // Filtro de fila (v1.1): cuando la venue tiene varias entradas (VIP,
  // general…), cada teléfono puede quedar asignado a UNA fila. Vacío =
  // aceptar boletas de cualquier tipo (comportamiento clásico).
  const [types, setTypes] = useState([]);
  const [rowFilter, setRowFilter] = useState("");
  // Log de los últimos escaneos de ESTE dispositivo (el más nuevo primero).
  // Para "yo sí entré": el portero muestra la hora y el resultado sin depender
  // del admin. Nunca sale del teléfono — no es reporte, es respaldo en puerta.
  const [scanLog, setScanLog] = useState([]);
  const [logOpen, setLogOpen] = useState(false);
  // Kiosco (default): pantalla completa, sin selector de evento ni Salir a un
  // toque. La puerta no navega libre; desbloquear exige mantener presionado.
  const [kiosk, setKiosk] = useState(true);
  const [holdPct, setHoldPct] = useState(0);
  const holdTimerRef = useRef(null);
  const holdTickRef = useRef(null);
  // Un solo tick háptico por umbral del desbloqueo (50% y 100%): la mano
  // siente el progreso sin mirar la barra.
  const holdBuzz50Ref = useRef(false);
  const holdBuzz100Ref = useRef(false);
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
      clearTimeout(holdTimerRef.current);
      clearInterval(holdTickRef.current);
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
      const data = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/types`,
      );
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

  // limpieza del timer al desmontar (y del wake lock: la pantalla vuelve a
  // apagarse normal cuando el bouncer sale del escáner)
  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      releaseWakeLock();
    },
    [],
  );

  // Cuenta atrás del cooldown de reintento (solo mientras hay uno pendiente).
  useEffect(() => {
    if (retryIn <= 0) return;
    const id = setInterval(() => setRetryIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [retryIn > 0]);

  async function startScanner() {
    setError("");
    setResult(null);
    if (!selectedEvent) {
      setError("Selecciona un evento primero");
      return;
    }
    setStarting(true);
    // El gesto de activar la cámara habilita también el audio (iOS lo exige)
    // y mantiene la pantalla encendida durante el servicio.
    requestWakeLock();
    autoReacquireWakeLock();
    try {
      const qr = new Html5Qrcode("qr-reader-region");
      html5Ref.current = qr;
      await qr.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        onScanSuccess,
        () => {},
      );
      setScanning(true);
      haptics.tick(); // la cámara respondió: confirmación sutil en la mano
    } catch (err) {
      setError("No se pudo iniciar la cámara: " + (err?.message || err));
    } finally {
      setStarting(false);
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
    releaseWakeLock();
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
    // Validando: la retícula detiene el barrido y late con el anillo de marca.
    // Sin esto, el tiempo entre lectura y respuesta se ve congelado.
    setValidating(true);
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/redeem`,
        {
          method: "POST",
          // Con fila asignada, el servidor rechaza boletas de otro tipo con
          // code=WRONG_TYPE (sin consumirlas). Sin filtro se omite el campo.
          body: JSON.stringify({
            raw_token: rawToken,
            ...(rowFilter ? { ticket_type_id: rowFilter } : {}),
          }),
        },
      );
      setResult(data);
      // Al log local: hora + resultado + nombre si el server lo devolvió.
      setScanLog((prev) =>
        [
          {
            at: new Date().toISOString(),
            code: data.code ?? (data.redeemed ? "GRANTED" : "NOT_VALID"),
            name: data.customer_name ?? null,
            detail: data.detail ?? null,
          },
          ...prev,
        ].slice(0, 20),
      );
      // Tres canales al mismo tiempo: vista (pantalla), tacto (vibración)
      // y oído (firma sonora por resultado — en un roncino no se siente la
      // vibración y no siempre se puede mirar la pantalla). Cada familia
      // tiene su firma táctil, la misma gramática de los sonidos.
      if (data.redeemed) {
        haptics.door.granted();
      } else if (data.code === "NOT_ACTIVE") {
        haptics.door.wait(); // no es rechazo: es "espera, tu boleta sirve"
      } else if (
        ["WRONG_TYPE", "INVALID_EVENT", "EVENT_NOT_LIVE"].includes(data.code)
      ) {
        haptics.door.attention(); // ámbar: corregir, no castigar
      } else {
        haptics.door.denied();
      }
      try {
        playForCode(data.code ?? (data.redeemed ? "GRANTED" : "NOT_VALID"));
      } catch {
        /* el audio nunca debe romper el canje */
      }
      if (data.code === "NOT_ACTIVE") {
        // No entra pero su boleta sirve: queda "aparcado" para reintentar
        // desde la misma pantalla cuando llegue la hora.
        setPendingRetry(rawToken);
        setRetryIn(RETRY_COOLDOWN_MS / 1000);
      } else {
        setPendingRetry(null);
      }
      // auto-reset para volver a escanear sin tocar nada
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(resetScan, RESULT_RESET_MS);
    } catch (err) {
      // Un error HTTP trae semántica de negocio desde el servidor (err.status
      // + mensaje accionable); solo la falta de conexión es "sin red".
      const errCode = err.status ? "SCAN_ERROR" : "NETWORK_ERROR";
      setResult({ code: errCode, detail: err.message });
      // Los fallos también quedan: "se escaneó y no pasó nada" es una
      // discusión de puerta tan real como un canje dudoso.
      setScanLog((prev) =>
        [
          {
            at: new Date().toISOString(),
            code: errCode,
            name: null,
            detail: err.message,
          },
          ...prev,
        ].slice(0, 20),
      );
      if (!err.status) {
        try {
          playOffline(); // "no puedes trabajar así" — distinto de un rechazo
        } catch {
          /* ignore */
        }
        haptics.door.offline();
      }
    } finally {
      setValidating(false);
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

  /** Reintento del token aparcado por NOT_ACTIVE: mismo flujo que un
      escaneo (manual:true salta el dedupe del mismo código). */
  async function retryPending() {
    if (!pendingRetry || retryIn > 0) return;
    await redeemToken(pendingRetry, { manual: true });
  }

  const style = result
    ? (RESULT_STYLES[result.code] ?? RESULT_STYLES.NOT_FOUND)
    : null;
  const selectedEventName =
    (events ?? []).find((ev) => ev.id === selectedEvent)?.name ?? "";

  // ===== Modo kiosco: desbloqueo por mantener presionado =====
  function startHold() {
    const t0 = Date.now();
    setHoldPct(0);
    holdBuzz50Ref.current = false;
    holdBuzz100Ref.current = false;
    holdTickRef.current = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - t0) / EXIT_HOLD_MS) * 100);
      setHoldPct(pct);
      // Ticks al 50% y al 100%: el progreso del desbloqueo se SIENTE.
      if (pct >= 100 && !holdBuzz100Ref.current) {
        holdBuzz100Ref.current = true;
        haptics.tick();
      } else if (pct >= 50 && !holdBuzz50Ref.current) {
        holdBuzz50Ref.current = true;
        haptics.tick();
      }
    }, 50);
    holdTimerRef.current = setTimeout(() => {
      clearInterval(holdTickRef.current);
      setKiosk(false);
      setHoldPct(0);
      haptics.success(); // desbloqueado: confirmación de acción completada
    }, EXIT_HOLD_MS);
  }
  function cancelHold() {
    clearTimeout(holdTimerRef.current);
    clearInterval(holdTickRef.current);
    setHoldPct(0);
    holdBuzz50Ref.current = false;
    holdBuzz100Ref.current = false;
  }
  // La puerta no puede esperar a que un escaneo falle para enterarse: el
  // banner de red aparece en vivo con el estado real de conexión.
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  return (
    <div className="flex min-h-[100dvh] flex-col bg-zinc-950 pb-[env(safe-area-inset-bottom)]">
      {/* Sin red, el bouncer lo sabe ANTES de escanear: el canje es server-
          autoritativo (los tokens crudos solo existen en el teléfono del
          invitado), así que sin conexión no hay validación posible — y no se
          inventa una cola que admitiría después QRs que hoy no se pueden
          verificar (screenshot de una boleta anulada entraría igual). */}
      {offline && (
        <div
          role="alert"
          className="bg-amber-950/80 px-4 py-2 text-center text-xs font-semibold text-amber-200"
        >
          ⚠️ Sin conexión: el escáner valida contra el server. Reconectá el dato
          para poder canjear.
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-white">
            Control de puerta
          </h1>
          <p className="text-xs text-zinc-500">
            {user?.full_name}
            {selectedEventName ? ` · ${selectedEventName}` : ""}
          </p>
        </div>
        {kiosk ? (
          /* Kiosco: salir exige MANTENER presionado (la barra llena el botón
             como feedback). Un toque accidental — bolsillo, roce — no saca a
             nadie del escáner en plena fila. El selector de evento y la
             navegación viven detrás del desbloqueo. */
          <button
            onMouseDown={startHold}
            onMouseUp={cancelHold}
            onMouseLeave={cancelHold}
            onTouchStart={startHold}
            onTouchEnd={cancelHold}
            onTouchCancel={cancelHold}
            onContextMenu={(e) => e.preventDefault()}
            className="relative min-h-[44px] select-none overflow-hidden rounded-lg border border-zinc-700 px-4 font-semibold text-zinc-300"
            aria-label="Mantén presionado para salir del modo kiosco"
          >
            <span
              className="absolute inset-y-0 left-0 bg-zinc-600"
              style={{ width: `${holdPct}%` }}
              aria-hidden="true"
            />
            <span className="relative">Mantén para salir</span>
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex">
              <LiveIndicator lastUpdated={lastEventsUpdate} live={false} />
            </span>
            <select
              value={selectedEvent ?? ""}
              onChange={(e) => setSelectedEvent(Number(e.target.value))}
              className="max-w-[52vw] rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-white sm:max-w-none"
            >
              <option value="" disabled>
                Evento…
              </option>
              {events === null
                ? null // el select se renderiza vacío un instante; el error global cubre fallos
                : events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.name}
                    </option>
                  ))}
            </select>
            <button
              onClick={() => setKiosk(true)}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800"
            >
              Bloquear
            </button>
            <button
              onClick={logout}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800"
            >
              Cerrar sesión
            </button>
          </div>
        )}
      </header>

      {/* Resultado a pantalla completa (semántica: verde entra, rojo no) */}
      {style ? (
        <button
          onClick={resetScan}
          /* El resultado se ANUNCIA (lectores de pantalla): en la oscuridad
             de la puerta el canal de respaldo no puede ser solo visual. */
          role="status"
          aria-live="assertive"
          className={`flex flex-1 flex-col items-center justify-center ${style.bg} p-6 transition-colors`}
        >
          {/* El icono gigante es decorado para ojo humano (ya está el color,
              el texto y el anuncio): oculto al lector para no leerlo dos veces. */}
          <span
            aria-hidden="true"
            className="animate-pop text-8xl font-black text-white drop-shadow-lg"
          >
            {style.icon}
          </span>
          <span className="animate-scale-in mt-4 text-5xl font-black uppercase tracking-tight text-white">
            {style.text}
          </span>
          <span className="animate-fade mt-2 text-lg font-semibold text-white/90">
            {(result?.code === "SCAN_ERROR" ||
              result?.code === "WRONG_TYPE" ||
              result?.code === "NOT_ACTIVE") &&
            result.detail
              ? result.detail
              : style.sub}
          </span>
          {result?.code === "NOT_ACTIVE" && (
            <span className="animate-fade mt-3 max-w-sm rounded-xl bg-black/25 px-4 py-2 text-center text-sm font-medium text-white/85">
              La boleta es válida: se escanea igual cuando llegue la hora. No se
              gastó.
            </span>
          )}
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
          {/* Retícula de escaneo: esquinas de encuadre + barrido en vivo.
              Al validar, el barrido se detiene y late el anillo de marca:
              la pantalla comunica "estoy pensando", no "me colgué". */}
          <div
            className={`scan-frame ${validating ? "is-busy" : ""} w-full max-w-sm`}
          >
            <div
              id="qr-reader-region"
              className="w-full overflow-hidden rounded-2xl ring-1 ring-zinc-800"
            />
            {scanning && (
              <>
                <span className="scan-corner" aria-hidden="true" />
                <span className="scan-sweep" aria-hidden="true" />
              </>
            )}
          </div>
          {!scanning && (
            <button
              onClick={startScanner}
              disabled={starting}
              className={`btn-primary mt-4 w-full max-w-sm !py-4 !text-lg ${
                starting ? "is-busy" : ""
              }`}
            >
              {starting && (
                <svg
                  className="btn-spinner"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )}
              {starting ? "Abriendo cámara…" : "Activar cámara"}
            </button>
          )}
          {scanning && (
            <button onClick={stopScanner} className="btn-ghost mt-4">
              Detener escaneo
            </button>
          )}

          {error && (
            <p className="mt-3 max-w-sm text-center text-sm text-red-400">
              {error}
            </p>
          )}

          {/* Reintento de la boleta aparcada por NOT_ACTIVE: sigue visible
              (aunque el resultado se haya ido) hasta que entre o se escanee
              otra boleta. Cooldown anti-spam de 20s. */}
          {pendingRetry && (
            <button
              onClick={retryPending}
              disabled={retryIn > 0}
              className="btn-ghost mt-3 w-full max-w-sm font-semibold disabled:opacity-50"
            >
              {retryIn > 0
                ? `Reintentar en ${retryIn}s`
                : "Reintentar boleta en espera"}
            </button>
          )}

          {/* Respaldo manual: cámara rota, permisos denegados, QR dañado */}
          <form
            onSubmit={submitManual}
            className="mt-5 flex w-full max-w-sm items-center gap-2"
          >
            <input
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="O escribe el código de la boleta"
              autoComplete="off"
              spellCheck={false}
              className="field min-w-0 flex-1"
            />
            <button
              type="submit"
              className="btn-ghost min-h-[44px] shrink-0 font-bold"
            >
              Validar
            </button>
          </form>

          {/* Filtro de fila: chips horizontales (scroll en pantallas chicas).
              Activo = blanco, igual que el patrón de chips del admin. */}
          {types.length > 0 && (
            <div className="no-scrollbar mt-3 w-full max-w-sm overflow-x-auto">
              <div className="flex w-max items-center gap-1.5">
                <button
                  onClick={() => {
                    setRowFilter("");
                    haptics.tick();
                  }}
                  aria-pressed={rowFilter === ""}
                  className={`chip min-h-[44px] rounded-full px-4 text-xs font-semibold ${
                    rowFilter === ""
                      ? "chip-active"
                      : "bg-zinc-800/70 text-zinc-300"
                  }`}
                >
                  Todas las filas
                </button>
                {types.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setRowFilter(t.id);
                      haptics.tick();
                    }}
                    aria-pressed={rowFilter === t.id}
                    className={`chip min-h-[44px] rounded-full px-4 text-xs font-semibold ${
                      rowFilter === t.id
                        ? "chip-active"
                        : "bg-zinc-800/70 text-zinc-300"
                    }`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="mt-4 max-w-sm text-center text-xs text-zinc-600">
            Verde = entra · Rojo = no entra. El resultado también aparece con el
            código manual.
          </p>

          {/* Log de los últimos escaneos de este teléfono: respaldo para
              discusiones en puerta ("yo sí entré"). Colapsado por defecto:
              durante el turno manda el escaneo, no la lectura. */}
          {scanLog.length > 0 && (
            <div className="mt-4 w-full max-w-sm">
              <button
                onClick={() => setLogOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-900"
              >
                <span>
                  Últimos escaneos{" "}
                  <span className="tnum text-zinc-500">({scanLog.length})</span>
                </span>
                <span className="text-zinc-500">
                  {logOpen ? "ocultar ▲" : "ver ▼"}
                </span>
              </button>
              {logOpen && (
                <ul className="mt-2 divide-y divide-zinc-800/70 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
                  {scanLog.map((s, i) => (
                    <li
                      key={`${s.at}-${i}`}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs"
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          s.code === "GRANTED"
                            ? "bg-emerald-400"
                            : [
                                  "NOT_ACTIVE",
                                  "WRONG_TYPE",
                                  "NETWORK_ERROR",
                                  "SCAN_ERROR",
                                ].includes(s.code)
                              ? "bg-amber-400"
                              : "bg-red-400"
                        }`}
                      />
                      <span className="tnum shrink-0 text-zinc-500">
                        {new Date(s.at).toLocaleTimeString("es-CO", {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                      <span className="truncate font-semibold text-zinc-300">
                        {SCAN_LOG_LABEL[s.code] ?? s.code}
                        {s.name ? ` · ${s.name}` : ""}
                      </span>
                      {s.detail && i === 0 && (
                        <span className="ml-auto truncate text-zinc-600">
                          {s.detail}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-center text-[10px] text-zinc-600">
                Solo en este dispositivo · sirve para aclarar en puerta
              </p>
            </div>
          )}

          {/* Aviso push cuando el admin abra puertas (published -> live) */}
          <div className="w-full max-w-sm">
            <PushToggle venueId={venueId} />
          </div>
        </div>
      )}
    </div>
  );
}
