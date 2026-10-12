import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
import { useUI } from "../lib/ui";
import { forceDarkOnce } from "../lib/theme";
import { haptics } from "../lib/haptics";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import {
  downloadSnapshot,
  getSnapshot,
  pendingCount,
  queueRedemption,
  syncQueue,
  validateOffline,
} from "../lib/doorCache";
import { LiveIndicator } from "../components/Brand";
import { PushToggle } from "../components/PushToggle";
import Icon from "../components/Icon";

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
  // Modo offline: la boleta está en el snapshot descargado. Entra AQUÍ, y la
  // DB dará la palabra final cuando el escaneo se sincronice.
  GRANTED_OFFLINE: {
    bg: "bg-emerald-600",
    text: "ENTRA (OFFLINE)",
    icon: "✓",
    sub: "Validada con el caché de puerta · se sincroniza al volver la red",
  },
  SNAPSHOT_MISSING: {
    bg: "bg-amber-600",
    text: "SIN CACHÉ",
    icon: "!",
    sub: "No hay descarga de puerta para este evento",
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
  GRANTED_OFFLINE: "ENTRA (OFFLINE)",
  SNAPSHOT_MISSING: "SIN CACHÉ",
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
  const ui = useUI();
  const venueId = firstVenueId(user);

  // La puerta SIEMPRE oscura: en un recinto a oscuras un flash de fondo
  // blanco ciega al portero. forceDarkOnce pone el candado y devuelve el
  // restaurador que se ejecuta al desmontar (sale el tema del usuario).
  useEffect(() => {
    const restore = forceDarkOnce();
    return restore;
  }, []);

  const [events, setEvents] = useState(null); // null = primera carga (skeleton)
  // Evento YA FIJO por el link de puerta. Si vino, esta persona está
  // asignada a esa noche (mig 025): el selector se aparta y el escaner se
  // abre en su turno, no en el primero que aparezca.
  const [searchParams] = useSearchParams();
  const fijo = Number(searchParams.get("evento")) || null;
  const [selectedEvent, setSelectedEvent] = useState(fijo);
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
  //
  // `fijo` es el evento del link de puerta (/puerta?token=…): cuando viene,
  // la persona YA está asignada a esa noche (mig 025) y el selector se
  // aparta — elegir otra sería cambiar de turno con un toque de más.
  const loadEvents = useCallback(async () => {
    if (!venueId) return;
    try {
      const data = await apiFetch(`/venues/${venueId}/events`);
      setEvents(data);
      setSelectedEvent((prev) => {
        if (fijo) return fijo;
        return prev ?? (data.length ? data[0].id : null);
      });
    } catch (e) {
      setError(e.message);
      setEvents((prev) => prev ?? []); // null = cargando; un fallo no es "cargando"
    }
  }, [venueId, fijo]);

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

    // ===== RUTA OFFLINE =====
    // Sin red PERO con snapshot descargado: se valida contra el caché y la
    // redención se ENCOLA. La DB arbitrará al sincronizar; por eso el verde
    // dice "OFFLINE" en el texto y el log distingue GRANTED_OFFLINE.
    if (!navigator.onLine) {
      setValidating(true);
      try {
        const local = await validateOffline(rawToken, selectedEvent, rowFilter || null);
        if (local.code === "GRANTED_OFFLINE") {
          await queueRedemption(rawToken, {
            typeId: rowFilter || null,
          });
          await refreshPending();
        }
        setResult(local);
        setScanLog((prev) =>
          [
            {
              at: new Date().toISOString(),
              code: local.code,
              name: local.customer_name ?? null,
              detail:
                local.code === "GRANTED_OFFLINE"
                  ? "pendiente de sync"
                  : null,
            },
            ...prev,
          ].slice(0, 20),
        );
        if (local.code === "GRANTED_OFFLINE") {
          haptics.door.granted();
          try {
            playForCode("GRANTED");
          } catch {
            /* ignore */
          }
        } else {
          haptics.door.attention();
        }
      } catch {
        setResult({ code: "SNAPSHOT_MISSING" });
        haptics.door.attention();
      } finally {
        setValidating(false);
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        resetTimerRef.current = setTimeout(resetScan, RESULT_RESET_MS);
      }
      return;
    }
    // ===== RUTA ONLINE (server-autoritativo, sin cambios) =====
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
      // El contador de la cabecera tiene que reflejar ESTE escaneo: sin esto
      // el número quedaba congelado hasta cambiar de evento.
      refreshStats();
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
  // ===== Modo offline de puerta =====
  // Snapshot descargado para el evento elegido (null = no hay). Con él, la
  // puerta valida sin red comparando SHA-256; sin él, sin red no hay magia
  // posible (server-autoritativo) y el banner lo dice.
  const [snapInfo, setSnapInfo] = useState(null); // {count, generated_at}
  // Cuántos escaneos offline esperan sincronización (badge del banner).
  const [pendingSync, setPendingSync] = useState(0);
  const [syncing, setSyncing] = useState(false);
  // Contador del evento al vuelo: lo pide junto con el snapshot para no gastar
  // un request extra; si falla, el badge "quedan X" no aparece (no miente).
  const [eventPulse, setEventPulse] = useState(null);
  // Lo que movió ESTE escáner en la noche (redemptions.scanned_by_user_id):
  // la cabecera ya dice cuántos entraron en total; esto dice cuántos fueron
  // por esta puerta. Se refresca después de cada escaneo, no una vez.
  const [myScans, setMyScans] = useState(null);

  const refreshPending = useCallback(async () => {
    try {
      setPendingSync(await pendingCount());
    } catch {
      setPendingSync(0);
    }
  }, []);

  // Contadores de la cabecera: el pulso del EVENTO (cuántos entraron en total)
  // y lo que movió ESTE escáner. Se piden juntos y se refrescan DESPUÉS de
  // cada escaneo y de cada sincronización: un contador que no cambia al
  // escanear no sirve para nada.
  const refreshStats = useCallback(async () => {
    if (!selectedEvent) {
      setEventPulse(null);
      setMyScans(null);
      return;
    }
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/pulse`)
      .then(setEventPulse)
      .catch(() => {});
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/scanner-stats`)
      .then(setMyScans)
      .catch(() => {});
  }, [selectedEvent, venueId]);

  // Info del snapshot al (cambiar de) evento; NO lo descarga solo: la
  // descarga es un botón (consume datos personales y ancho de banda).
  useEffect(() => {
    let alive = true;
    if (!selectedEvent) {
      setSnapInfo(null);
      setEventPulse(null);
      setMyScans(null);
      return;
    }
    getSnapshot(selectedEvent)
      .then((s) => alive && setSnapInfo(s ? { count: s.count, generated_at: s.generated_at } : null))
      .catch(() => alive && setSnapInfo(null));
    // Contadores del turno (pulso del evento + lo de este escáner). Antes
    // este efecto tenía el MISMO fetch duplicado y un `return` de limpieza en
    // el medio: el callback terminaba en ese return, así que refreshPending()
    // nunca corría y el badge de pendientes quedaba siempre en 0 — justo el
    // dato que el bouncer necesita sin red.
    refreshStats();
    refreshPending();
    return () => {
      alive = false;
    };
  }, [selectedEvent, venueId, refreshPending, refreshStats]);

  /** Descarga manual del snapshot: la puerta prepara su modo sin red. */
  async function prepareOffline() {
    if (!selectedEvent) return;
    setError("");
    try {
      const snap = await downloadSnapshot(venueId, selectedEvent);
      setSnapInfo({ count: snap.count, generated_at: snap.generated_at });
      haptics.tick();
    } catch (e) {
      setError("No se pudo descargar el caché de puerta: " + e.message);
    }
  }

  /** Sincroniza la cola offline; la DB re-evalúa cada token. */
  async function doSync() {
    if (syncing || pendingSync === 0) return;
    setSyncing(true);
    try {
      const out = await syncQueue(venueId, selectedEvent);
      await Promise.all([refreshPending(), refreshStats()]);
      ui.toast(
        `Sincronizado: ${out.granted} entraron, ${out.already_redeemed} ya estaban, ${out.rejected} rechazadas`,
      );
    } catch {
      /* la red aún no: la cola espera; el banner sigue avisando */
    } finally {
      setSyncing(false);
    }
  }

  // La puerta no puede esperar a que un escaneo falle para enterarse: el
  // banner de red aparece en vivo con el estado real de conexión.
  // OJO: `offline` se declara ANTES del efecto que lo usa en sus deps —
  // leerlo en [offline] con el useState abajo era un TDZ que tumbaba toda
  // la pantalla de puerta al montar ("Cannot access '$' before init").
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

  // Al volver la conexión: sincroniza solo (y reintenta el badge).
  useEffect(() => {
    if (!offline && pendingSync > 0 && selectedEvent) {
      doSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline]);

  return (
    <div className="app-shell flex min-h-[100dvh] flex-col bg-zinc-950 pb-[env(safe-area-inset-bottom)]">
      {/* Sin red: si hay snapshot, la puerta SIGUE trabajando (valida contra
          el caché y encola); si no hay, aquí no hay magia posible — el banner
          lo dice sin inventar una validez que no se puede verificar. */}
      {offline && (
        <div
          role="alert"
          className="bg-amber-950/80 px-4 py-2 text-center text-xs font-semibold text-amber-200"
        >
          {snapInfo
            ? `⚠️ Sin conexión: validando con el caché (${snapInfo.count} boletas). Los ingresos se sincronizan al reconectar.${pendingSync > 0 ? ` Pendientes: ${pendingSync}.` : ""}`
            : "⚠️ Sin conexión y sin caché de puerta: descarga el caché con red para poder canjear offline."}
        </div>
      )}
      {/* La puerta existe para una noche EN PUERTA. Si el evento todavía no
          abrió (draft/publicado) o ya cerró (terminado/cancelado), el escáner
          rechaza todo y el bouncer quedaría adivinando por qué. Este aviso lo
          dice antes de que empiece a escanear. */}
      {selectedEvent && eventPulse && eventPulse.status !== "live" && (
        <div
          role="status"
          className="bg-amber-950/70 px-4 py-2 text-center text-xs font-semibold text-amber-200"
        >
          {["ended", "cancelled"].includes(eventPulse.status)
            ? "Esta noche ya cerró: el escáner no va a aceptar boletas."
            : "La noche todavía no abrió: el escáner va a rechazar las boletas hasta que el admin abra puertas."}
        </div>
      )}
      <header className="door-head flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="min-w-0">
          <h1 className="door-title text-lg font-bold tracking-tight text-white">
            Control de puerta
          </h1>            <p className="text-xs text-zinc-500">
            {user?.full_name}
            {selectedEventName ? ` · ${selectedEventName}` : ""}
          </p>
          {/* Contador del turno: lo que el bouncer necesita ver para saber
              quién entra y cuántos quedan, sin tocar el selector ni el bajo. */}
          {fijo && eventPulse && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="text-zinc-200 font-semibold text-2xs">
                  {eventPulse.redeemed}
                </span>
                <span className="text-zinc-500">ingresaron</span>
              </span>
              <span className="tnum text-zinc-600">
                {Math.max(0, eventPulse.capacity - eventPulse.redeemed)}
              </span>
              <span className="text-zinc-500">quedan de {eventPulse.capacity}</span>
              {eventPulse.issued > 0 && (
                <span className="text-zinc-500">· {eventPulse.issued - eventPulse.redeemed} pendientes</span>
              )}
              {/* Lo que movió este escáner: en un evento con dos puertas, el
                  total del evento no dice si la noche la trabajó esta puerta. */}
              {myScans && myScans.granted > 0 && (
                <span className="text-emerald-300/90">
                  · vos: {myScans.granted}
                </span>
              )}
            </div>
          )
          }
          {!fijo && eventPulse && eventPulse.issued > 0 && (
            <div className="mt-2 flex items-center gap-2 text-2xs text-zinc-500">
              <span className="flex items-center gap-1.5">
                <Icon name="ticket" className="h-3 w-3 text-zinc-600" />
                <span className="text-zinc-200">{eventPulse.redeemed}</span>
                <span className="text-zinc-500">ingresaron ·</span>
              </span>
              <span className="tnum text-zinc-600">
                {Math.max(0, eventPulse.capacity - eventPulse.redeemed)}
              </span>
              <span className="text-zinc-500">quedan de {eventPulse.capacity}</span>
              {/* Mismo contador que en el modo con link: sin él, el bouncer
                  que entra por el menú no ve cuánto movió su escáner. */}
              {myScans && myScans.granted > 0 && (
                <span className="text-emerald-300/90">
                  · vos: {myScans.granted}
                </span>
              )}
            </div>
          )}
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
            {/* Con link de puerta la noche YA está elegida (mig 025): el selector se
                aparta a propósito. Dejarlo sería ofrecerle a alguien que ya
                sabe su noche cambiar de turno con un toque accidental. */}
            {!fijo && (
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
            )}
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
          className={`scan-result flex flex-1 flex-col items-center justify-center ${style.bg} p-6 transition-colors`}
          data-result={result?.code === "GRANTED" || result?.code === "GRANTED_OFFLINE" ? "ok" : "no"}
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
              <p className="mt-1 text-center text-2xs text-zinc-600">
                Solo en este dispositivo · sirve para aclarar en puerta
              </p>
            </div>
          )}

          {/* Caché de puerta (modo offline): descarga manual y estado. La
              descarga es un acto explícito del bouncer (baja nombres+hashes
              del evento): nunca automática en segundo plano. */}
          <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-zinc-300">
                Caché de puerta (sin red)
              </p>
              {snapInfo ? (
                <button
                  onClick={prepareOffline}
                  disabled={starting}
                  className="btn-mini"
                  data-variant="brand"
                >
                  Actualizar
                </button>
              ) : (
                <button
                  onClick={prepareOffline}
                  disabled={starting || !selectedEvent}
                  className="btn-mini"
                  data-variant="brand"
                >
                  Descargar
                </button>
              )}
            </div>
            {snapInfo ? (
              <p className="tnum mt-1 text-2xs text-zinc-500">
                {snapInfo.count} boletas vivas · descargado{" "}
                {new Date(snapInfo.generated_at).toLocaleTimeString("es-CO", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {offline && " · validando sin red"}
              </p>
            ) : (
              <p className="mt-1 text-2xs text-zinc-500">
                Baja los hashes de las boletas vigentes para validar en la fila
                aunque el dato se caiga. Nada de tokens: solo huellas SHA-256.
              </p>
            )}
            {pendingSync > 0 && (
              <button
                onClick={doSync}
                disabled={syncing}
                className="btn-mini mt-1.5"
                data-variant="success"
              >
                {syncing
                  ? "Sincronizando…"
                  : `Sincronizar ${pendingSync} escaneo${pendingSync === 1 ? "" : "s"}`}
              </button>
            )}
          </div>

          {/* Aviso push cuando el admin abra puertas (published -> live) */}
          <div className="w-full max-w-sm">
            <PushToggle venueId={venueId} />
          </div>
        </div>
      )}
    </div>
  );
}
