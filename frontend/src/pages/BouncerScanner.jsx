/**
 * Puerta — la app del puesto.
 *
 * Una sola pantalla para la noche: escanear (centro), cambiar de cifra
 * (Entrada/Salida), abrir código manual, resolver incidencias y revisar el
 * turno. La cámara no se tapa con menús; las tres acciones viven al pie.
 *
 * La autorización es del TELÉFONO (mig 064): el link de Puerta se canjea una
 * vez y deja un token de dispositivo. Relevar o revocar el puesto lo mata en
 * el servidor, no solo en esta interfaz.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
import { haptics } from "../lib/haptics";
import {
  downloadSnapshot,
  getSnapshot,
  pendingCount,
  pendingIncidentCount,
  queueIncident,
  queueRedemption,
  syncIncidentQueue,
  syncQueue,
  validateOffline,
} from "../lib/doorCache";
import { clearDoorDevice, doorHeaders, getDoorDevice } from "../lib/doorDevice";
import { Logo } from "../components/Brand";
import Icon from "../components/Icon";
import useDocumentTitle from "../lib/useDocumentTitle";

const RESULT_RESET_MS = 7000;

const RESULT_META = {
  GRANTED: {
    tone: "ok",
    icon: "check",
    kicker: "Ingreso confirmado",
    title: "Puede entrar",
  },
  EXITED: {
    tone: "ok",
    icon: "arrowRight",
    kicker: "Salida registrada",
    title: "Salió del recinto",
  },
  GRANTED_OFFLINE: {
    tone: "ok",
    icon: "check",
    kicker: "Validada en este teléfono",
    title: "Puede entrar",
    detail: "Pendiente de confirmar cuando vuelva la conexión.",
  },
  ALREADY_REDEEMED: {
    tone: "danger",
    icon: "close",
    kicker: "Boleta ya utilizada",
    title: "No puede volver a entrar",
  },
  ALREADY_REDEEMED_OFFLINE: {
    tone: "danger",
    icon: "close",
    kicker: "Escaneada en este teléfono",
    title: "Ya está en la cola de sincronización",
  },
  ALREADY_OUTSIDE: {
    tone: "warn",
    icon: "alert",
    kicker: "Salida repetida",
    title: "Ya había salido",
  },
  CAPACITY_REACHED: {
    tone: "danger",
    icon: "alert",
    kicker: "Aforo completo",
    title: "El recinto está lleno",
    detail: "La boleta no se consumió. Esperá una salida para volver a intentar.",
  },
  ZONE_CAPACITY_REACHED: {
    tone: "danger",
    icon: "alert",
    kicker: "Zona completa",
    title: "No puede entrar a esta zona",
    detail: "Redirigí a otra zona o esperá una salida. La boleta no se consumió.",
  },
  WRONG_TYPE: {
    tone: "warn",
    icon: "arrowRight",
    kicker: "Tipo de boleta incorrecto",
    title: "Indicá el acceso correcto",
  },
  UNDER_AGE: {
    tone: "warn",
    icon: "shield",
    kicker: "Restricción de edad",
    title: "No cumple la edad mínima",
  },
  NOT_ACTIVE: {
    tone: "warn",
    icon: "clock",
    kicker: "QR todavía no activo",
    title: "Todavía no puede entrar",
  },
  NOT_FOUND: {
    tone: "danger",
    icon: "close",
    kicker: "Código no encontrado",
    title: "No es una boleta de esta noche",
  },
  INVALID_EVENT: {
    tone: "warn",
    icon: "alert",
    kicker: "Otra noche",
    title: "Boleta de otro evento",
  },
  EVENT_NOT_LIVE: {
    tone: "warn",
    icon: "lock",
    kicker: "Puerta cerrada",
    title: "El evento no está abierto",
  },
  NOT_VALID: {
    tone: "danger",
    icon: "close",
    kicker: "Boleta anulada",
    title: "No puede entrar",
  },
  SNAPSHOT_MISSING: {
    tone: "warn",
    icon: "alert",
    kicker: "Sin caché de puerta",
    title: "No se puede verificar sin red",
    detail: "Prepará la puerta sin conexión desde Turno.",
  },
  NOT_IN_CACHE: {
    tone: "warn",
    icon: "alert",
    kicker: "No está en la caché",
    title: "No se puede confirmar sin red",
    detail: "Pudo emitirse después de la descarga. Reconectá para validar.",
  },
  NETWORK_ERROR: {
    tone: "warn",
    icon: "alert",
    kicker: "Sin conexión",
    title: "No se pudo validar",
  },
  DEVICE_REVOKED: {
    tone: "danger",
    icon: "lock",
    kicker: "Autorización de este teléfono",
    title: "El puesto ya no está autorizado",
    detail: "Pedile a Administración un link nuevo para este puesto.",
  },
  OFFLINE_EXIT: {
    tone: "warn",
    icon: "alert",
    kicker: "Salida sin conexión",
    title: "La salida necesita conexión",
    detail: "El aforo lo descuenta el servidor. No se inventa una salida local.",
  },
  SCAN_ERROR: {
    tone: "warn",
    icon: "alert",
    kicker: "No se pudo registrar",
    title: "Revisá el aviso",
  },
};

const INCIDENT_REASONS = [
  "Boleta no válida",
  "QR dañado o ilegible",
  "Boleta duplicada",
  "Problema de aforo",
  "Persona sin boleta",
  "Otro",
];

const INCIDENT_STATUS = {
  open: { label: "Abierta", tone: "warn" },
  reviewing: { label: "En revisión", tone: "info" },
  resolved: { label: "Resuelta", tone: "ok" },
};

function clock(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
}

function dateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-CO", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function waHref(phone, text = "") {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : null;
}

function ResultSheet({ result, onClose, onIncident }) {
  const meta = RESULT_META[result.code] || RESULT_META.SCAN_ERROR;
  return (
    <div className="door2-result-backdrop" role="presentation" onClick={onClose}>
      <section
        className="door2-result"
        data-tone={meta.tone}
        role="alertdialog"
        aria-modal="true"
        aria-label={meta.kicker}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="door2-result-icon">
          <Icon name={meta.icon} className="h-8 w-8" />
        </div>
        <p className="door2-result-kicker">{meta.kicker}</p>
        <h2>{meta.title}</h2>
        {result.customer_name && <p className="door2-result-name">{result.customer_name}</p>}
        <div className="door2-result-tags">
          {result.ticket_type && <span>{result.ticket_type}</span>}
          {result.ticket_id && <span>#{String(result.ticket_id).padStart(4, "0")}</span>}
        </div>
        {(result.detail || meta.detail) && (
          <p className="door2-result-detail">{result.detail || meta.detail}</p>
        )}
        <div className="door2-result-actions">
          {result.ticket_id && onIncident && (
            <button type="button" className="door2-btn door2-btn--soft" onClick={onIncident}>
              <Icon name="flag" className="h-4 w-4" />
              Reportar incidencia
            </button>
          )}
          <button type="button" className="door2-btn door2-btn--primary" onClick={onClose}>
            Volver a escanear
          </button>
        </div>
      </section>
    </div>
  );
}

function Sheet({ title, subtitle, onClose, children }) {
  return (
    <div className="door2-sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="door2-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="door2-sheet-head">
          <button type="button" className="door2-back" onClick={onClose} aria-label="Volver">
            <Icon name="back" className="h-5 w-5" />
          </button>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <span className="door2-sheet-spacer" aria-hidden="true" />
        </header>
        <div className="door2-sheet-body">{children}</div>
      </section>
    </div>
  );
}

export default function BouncerScanner() {
  useDocumentTitle("Puerta · Enty");
  const { user } = useAuth();
  const ui = useUI();
  const venueId = activeVenueId(user);
  const [searchParams] = useSearchParams();
  const fijo = Number(searchParams.get("evento")) || null;
  const deepIncident = Number(searchParams.get("incidencia")) || null;

  const [events, setEvents] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(fijo);
  const [context, setContext] = useState(null);
  const [contextError, setContextError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [panel, setPanel] = useState(null); // manual | incidents | shift
  const [scanMode, setScanMode] = useState(
    () => localStorage.getItem("tf_scan_mode") || "in",
  );
  const [offline, setOffline] = useState(!navigator.onLine);
  const [pendingScans, setPendingScans] = useState(0);
  const [pendingIncidents, setPendingIncidents] = useState(0);
  const [snapInfo, setSnapInfo] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const [incidents, setIncidents] = useState([]);
  const [incidentLoading, setIncidentLoading] = useState(false);
  const [incidentDetail, setIncidentDetail] = useState(null);
  const [incidentView, setIncidentView] = useState("list");
  const [incidentReason, setIncidentReason] = useState(INCIDENT_REASONS[0]);
  const [incidentNote, setIncidentNote] = useState("");
  const [incidentTicket, setIncidentTicket] = useState(null);
  const [incidentComment, setIncidentComment] = useState("");
  const [incidentChannel, setIncidentChannel] = useState("note");
  const [incidentBusy, setIncidentBusy] = useState(false);

  const [shiftRequests, setShiftRequests] = useState([]);
  const [shiftForm, setShiftForm] = useState(false);
  const [shiftReason, setShiftReason] = useState("");
  const [shiftPhone, setShiftPhone] = useState("");

  const html5Ref = useRef(null);
  const lastScannedRef = useRef("");
  const resetTimerRef = useRef(null);
  const autoPrepRef = useRef(new Set());

  useEffect(() => {
    if (deepIncident) {
      setPanel("incidents");
      loadIncident(deepIncident);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepIncident]);

  useEffect(() => {
    localStorage.setItem("tf_scan_mode", scanMode);
  }, [scanMode]);

  const loadEvents = useCallback(async () => {
    if (!venueId) return;
    try {
      const data = await apiFetch(`/venues/${venueId}/events`);
      setEvents(data);
      setSelectedEvent((prev) => {
        if (fijo) return fijo;
        if (prev) return prev;
        return data.find((e) => e.status === "live")?.id ?? data[0]?.id ?? null;
      });
      return data;
    } catch (e) {
      setEvents((prev) => prev ?? []);
      setError(e.message);
      return [];
    }
  }, [venueId, fijo]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const loadContext = useCallback(async () => {
    if (!venueId || !selectedEvent) return;
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/door-context`,
        { headers: doorHeaders(selectedEvent), fresh: true },
      );
      setContext(data);
      setContextError("");
    } catch (e) {
      setContextError(e.message || "No pudimos leer el estado de la puerta.");
      if (e.status === 403) setContext(null);
    }
  }, [venueId, selectedEvent]);

  useEffect(() => {
    loadContext();
    const id = setInterval(() => {
      if (!document.hidden) loadContext();
    }, 15000);
    const onVisible = () => {
      if (!document.hidden) loadContext();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadContext]);

  useEffect(() => {
    let alive = true;
    if (!selectedEvent) {
      setSnapInfo(null);
      return undefined;
    }
    getSnapshot(selectedEvent)
      .then((s) => {
        if (alive) setSnapInfo(s ? { count: s.count, generated_at: s.generated_at } : null);
      })
      .catch(() => alive && setSnapInfo(null));
    return () => {
      alive = false;
    };
  }, [selectedEvent]);

  useEffect(() => {
    if (!selectedEvent || snapInfo || context?.event_status !== "live") return;
    if (autoPrepRef.current.has(selectedEvent)) return;
    autoPrepRef.current.add(selectedEvent);
    downloadSnapshot(venueId, selectedEvent)
      .then((snap) => setSnapInfo({ count: snap.count, generated_at: snap.generated_at }))
      .catch(() => autoPrepRef.current.delete(selectedEvent));
  }, [selectedEvent, snapInfo, context?.event_status, venueId]);

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

  const refreshPending = useCallback(async () => {
    if (!selectedEvent) return;
    try {
      setPendingScans(await pendingCount(selectedEvent));
      setPendingIncidents(await pendingIncidentCount(selectedEvent));
    } catch {
      setPendingScans(0);
      setPendingIncidents(0);
    }
  }, [selectedEvent]);

  useEffect(() => {
    refreshPending();
  }, [refreshPending]);

  const loadIncidents = useCallback(async () => {
    if (!venueId || !selectedEvent) return;
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/door-incidents`,
        { headers: doorHeaders(selectedEvent), fresh: true },
      );
      setIncidents(data);
    } catch {
      /* la lista no debe tumbar el escaneo */
    }
  }, [venueId, selectedEvent]);

  const loadShiftRequests = useCallback(async () => {
    if (!venueId || !selectedEvent) return;
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/door-shift-requests`,
        { fresh: true },
      );
      setShiftRequests(data);
    } catch {
      /* se reintenta al abrir Turno */
    }
  }, [venueId, selectedEvent]);

  useEffect(() => {
    loadIncidents();
    loadShiftRequests();
  }, [loadIncidents, loadShiftRequests]);

  async function loadIncident(id) {
    if (!venueId || !selectedEvent || !id) return;
    setIncidentLoading(true);
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/door-incidents/${id}`,
        { headers: doorHeaders(selectedEvent), fresh: true },
      );
      setIncidentDetail(data);
      setIncidentView("detail");
    } catch (e) {
      ui.error(e.message);
    } finally {
      setIncidentLoading(false);
    }
  }

  async function startScanner() {
    setError("");
    if (!selectedEvent) {
      setError("Elegí el evento de esta noche.");
      return;
    }
    setStarting(true);
    requestWakeLock();
    autoReacquireWakeLock();
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const qr = new Html5Qrcode("door2-qr-region");
      html5Ref.current = qr;
      await qr.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        onScanSuccess,
        () => {},
      );
      setScanning(true);
      haptics.tick();
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

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      stopScanner();
    },
    [],
  );

  function closeResult() {
    setResult(null);
    lastScannedRef.current = "";
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }

  function scheduleReset() {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(closeResult, RESULT_RESET_MS);
  }

  async function redeemToken(rawToken, { manual = false } = {}) {
    if (!selectedEvent) return;
    if (!manual && rawToken === lastScannedRef.current) return;
    lastScannedRef.current = rawToken;
    setValidating(true);
    const typeId = context?.assigned_ticket_type_id ?? null;
    const doorName = context?.assigned_door ?? null;

    if (!navigator.onLine) {
      if (scanMode === "out") {
        setResult({ code: "OFFLINE_EXIT" });
        setValidating(false);
        scheduleReset();
        return;
      }
      try {
        const local = await validateOffline(rawToken, selectedEvent, typeId);
        if (local.code === "GRANTED_OFFLINE") {
          await queueRedemption(rawToken, {
            typeId,
            eventId: selectedEvent,
            doorId: doorName,
          });
          await refreshPending();
        }
        setResult(local);
        if (local.code === "GRANTED_OFFLINE") {
          haptics.door.granted();
          playForCode("GRANTED");
        } else {
          haptics.door.attention();
          playForCode(local.code);
        }
        scheduleReset();
      } catch {
        setResult({ code: "SNAPSHOT_MISSING" });
        playOffline();
      } finally {
        setValidating(false);
      }
      return;
    }

    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/redeem`,
        {
          method: "POST",
          headers: doorHeaders(selectedEvent),
          body: JSON.stringify({
            raw_token: rawToken,
            ...(typeId ? { ticket_type_id: typeId } : {}),
            ...(doorName ? { door_id: doorName } : {}),
          }),
        },
      );
      setResult(data);
      loadContext();
      loadIncidents();
      if (data.redeemed) haptics.door.granted();
      else if (["WRONG_TYPE", "UNDER_AGE", "NOT_ACTIVE"].includes(data.code))
        haptics.door.attention();
      else haptics.door.denied();
      playForCode(data.code ?? (data.redeemed ? "GRANTED" : "NOT_VALID"));
      scheduleReset();
    } catch (e) {
      const code = e.status === 403 ? "DEVICE_REVOKED" : e.status ? "SCAN_ERROR" : "NETWORK_ERROR";
      setResult({ code, detail: e.message });
      if (e.status === 403) {
        setContextError(e.message);
        loadContext();
      }
      if (!e.status) {
        playOffline();
        haptics.door.offline();
      }
    } finally {
      setValidating(false);
    }
  }

  async function exitToken(rawToken, { manual = false } = {}) {
    if (!selectedEvent) return;
    if (!manual && rawToken === lastScannedRef.current) return;
    lastScannedRef.current = rawToken;
    if (!navigator.onLine) {
      setResult({ code: "OFFLINE_EXIT" });
      scheduleReset();
      return;
    }
    setValidating(true);
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/exit`,
        {
          method: "POST",
          headers: doorHeaders(selectedEvent),
          body: JSON.stringify({
            raw_token: rawToken,
            ...(context?.assigned_door ? { door_id: context.assigned_door } : {}),
          }),
        },
      );
      setResult({
        code: data.code,
        customer_name: data.customer_name ?? null,
        ticket_type: data.ticket_type ?? null,
        ticket_id: data.ticket_id ?? null,
        detail:
          data.code === "ALREADY_OUTSIDE"
            ? "Ya había salido del recinto."
            : data.code === "EXITED"
              ? "La salida libera lugar para el aforo."
              : null,
      });
      if (data.code === "EXITED") haptics.door.granted();
      else haptics.door.attention();
      playForCode(data.code === "EXITED" ? "GRANTED" : "WRONG_TYPE");
      loadContext();
      scheduleReset();
    } catch (e) {
      setResult({
        code: e.status === 403 ? "DEVICE_REVOKED" : "SCAN_ERROR",
        detail: e.message,
      });
    } finally {
      setValidating(false);
    }
  }

  async function onScanSuccess(decodedText) {
    if (panel || result) return;
    if (scanMode === "out") await exitToken(decodedText);
    else await redeemToken(decodedText);
  }

  async function submitManual(e) {
    e.preventDefault();
    const token = manualCode.trim();
    if (token.length < 8) {
      setError("El código es demasiado corto.");
      return;
    }
    setError("");
    setManualCode("");
    setPanel(null);
    if (scanMode === "out") await exitToken(token, { manual: true });
    else await redeemToken(token, { manual: true });
  }

  async function prepareOffline() {
    if (!selectedEvent) return;
    try {
      const snap = await downloadSnapshot(venueId, selectedEvent);
      setSnapInfo({ count: snap.count, generated_at: snap.generated_at });
      haptics.tick();
      ui.success(`Puerta preparada sin conexión: ${snap.count} boletas.`);
    } catch (e) {
      ui.error("No se pudo descargar el caché: " + e.message);
    }
  }

  async function doSync() {
    if (syncing || !selectedEvent) return;
    setSyncing(true);
    try {
      const [scans, incs] = await Promise.all([
        pendingScans > 0 ? syncQueue(venueId, selectedEvent) : null,
        pendingIncidents > 0 ? syncIncidentQueue(venueId, selectedEvent) : null,
      ]);
      await refreshPending();
      await loadContext();
      await loadIncidents();
      const sc = scans ? `${scans.granted} entraron, ${scans.already_redeemed} ya estaban` : null;
      const ic = incs ? `${incs.synced} incidencias enviadas` : null;
      ui.success([sc, ic].filter(Boolean).join(" · ") || "Nada pendiente.");
    } catch {
      ui.error("Todavía no hay conexión. La cola sigue guardada.");
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (!offline && (pendingScans > 0 || pendingIncidents > 0) && selectedEvent) {
      doSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline]);

  function openIncidentForResult() {
    setIncidentTicket(
      result?.ticket_id
        ? {
            id: result.ticket_id,
            ref: `#${String(result.ticket_id).padStart(4, "0")}`,
            type: result.ticket_type,
          }
        : null,
    );
    setIncidentReason(
      result?.code === "ALREADY_REDEEMED"
        ? "Boleta duplicada"
        : result?.code === "WRONG_TYPE"
          ? "Boleta no válida"
          : INCIDENT_REASONS[0],
    );
    setIncidentNote(result?.detail || "");
    setIncidentView("new");
    setIncidentDetail(null);
    setPanel("incidents");
    setResult(null);
  }

  function openIncidentList() {
    setPanel("incidents");
    setIncidentView("list");
    setIncidentDetail(null);
    setIncidentTicket(null);
    setIncidentNote("");
    loadIncidents();
  }

  async function createIncident(e) {
    e.preventDefault();
    if (!selectedEvent || incidentBusy) return;
    setIncidentBusy(true);
    const payload = {
      reason: incidentReason,
      note: incidentNote.trim() || null,
      ...(incidentTicket?.id ? { ticket_id: incidentTicket.id } : {}),
      ...(incidentTicket?.ref ? { ticket_ref: incidentTicket.ref } : {}),
    };
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/door-incidents`,
        {
          method: "POST",
          headers: doorHeaders(selectedEvent),
          body: JSON.stringify(payload),
        },
      );
      setIncidents((prev) => [data, ...prev]);
      setIncidentNote("");
      setIncidentTicket(null);
      setIncidentView("list");
      ui.success("Incidencia reportada. Administración ya la ve.");
      loadContext();
    } catch (err) {
      if (!err.status && !navigator.onLine) {
        await queueIncident(selectedEvent, payload);
        await refreshPending();
        setIncidentNote("");
        setIncidentTicket(null);
        setIncidentView("list");
        ui.success("Incidencia guardada. Se envía al reconectar.");
      } else {
        ui.error(err.message);
      }
    } finally {
      setIncidentBusy(false);
    }
  }

  async function sendIncidentComment(channel = "note") {
    if (!incidentDetail || incidentBusy) return;
    const body =
      incidentComment.trim() ||
      (channel === "call"
        ? "Llamada realizada a Administración."
        : channel === "whatsapp"
          ? "Mensaje enviado a Administración."
          : "");
    if (!body) return;
    setIncidentBusy(true);
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/door-incidents/${incidentDetail.id}/comments`,
        {
          method: "POST",
          headers: doorHeaders(selectedEvent),
          body: JSON.stringify({ body, channel }),
        },
      );
      setIncidentDetail(data);
      setIncidentComment("");
      loadIncidents();
    } catch (e) {
      ui.error(e.message);
    } finally {
      setIncidentBusy(false);
    }
  }

  async function requestShift(e) {
    e.preventDefault();
    if (!selectedEvent) return;
    try {
      await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/door-shift-requests`,
        {
          method: "POST",
          headers: doorHeaders(selectedEvent),
          body: JSON.stringify({
            reason: shiftReason.trim(),
            requested_phone: shiftPhone.trim() || null,
          }),
        },
      );
      setShiftReason("");
      setShiftPhone("");
      setShiftForm(false);
      loadShiftRequests();
      ui.success("Relevo solicitado. Administración lo va a revisar.");
    } catch (err) {
      ui.error(err.message);
    }
  }

  function clearAuthorization() {
    if (!selectedEvent) return;
    clearDoorDevice(selectedEvent);
    setContext(null);
    setContextError("Este teléfono ya no tiene autorización guardada.");
  }

  const selectedEventData = (events ?? []).find((e) => e.id === selectedEvent);
  const device = context?.device || getDoorDevice(selectedEvent);
  const openIncidents = incidents.filter((i) => i.status !== "resolved").length;
  const authorized = Boolean(
    device?.status ? device.status === "active" : device?.token,
  );

  if (!selectedEvent && events !== null) {
    return (
      <main className="door2-shell door2-empty">
        <Logo size="lg" />
        <h1>No hay una noche asignada</h1>
        <p>
          Abrí el link de Puerta que te envió Administración. Ese link deja este
          teléfono autorizado para una noche y un puesto concretos.
        </p>
        <button type="button" className="door2-btn door2-btn--primary" onClick={loadEvents}>
          Reintentar
        </button>
      </main>
    );
  }

  return (
    <main className="door2-shell">
      <h1 className="sr-only">Control de puerta</h1>
      <header className="door2-top">
        <Logo size="sm" compact />
        <button type="button" className="door2-event-button" onClick={() => setPanel("shift")}>
          <span className="door2-kicker">Puerta</span>
          <strong>{context?.event_name || selectedEventData?.name || "Cargando noche…"}</strong>
          <span>
            {context?.assigned_door || "Sin acceso asignado"} · {user?.full_name}
          </span>
        </button>
        <button
          type="button"
          className="door2-icon-button"
          aria-label="Abrir turno"
          onClick={() => {
            setPanel("shift");
            loadShiftRequests();
          }}
        >
          <Icon name="clock" className="h-5 w-5" />
        </button>
      </header>

      <div className="door2-content">
        {offline && (
          <div className="door2-banner" data-tone="warn" role="alert">
            <Icon name="alert" className="h-4 w-4" />
            <span>
              {snapInfo
                ? `Sin conexión: validando con ${snapInfo.count} boletas del caché.`
                : "Sin conexión y sin caché: prepará la puerta desde Turno antes de la fila."}
              {pendingScans > 0 && ` ${pendingScans} ingresos esperan sincronizar.`}
            </span>
          </div>
        )}
        {contextError && (
          <div className="door2-banner" data-tone="danger" role="alert">
            <Icon name="lock" className="h-4 w-4" />
            <span>{contextError}</span>
            <button type="button" onClick={() => setPanel("shift")}>Ver turno</button>
          </div>
        )}
        {context && !context.door_open && (
          <div className="door2-banner" data-tone="warn" role="status">
            <Icon name="lock" className="h-4 w-4" />
            <span>
              {["ended", "cancelled"].includes(context.event_status)
                ? "Esta noche ya cerró. La puerta no acepta más boletas."
                : "La noche todavía no abrió. Administración tiene que abrir puertas."}
            </span>
          </div>
        )}

        <section className="door2-overview" aria-label="Estado de la puerta">
          <div className="door2-state" data-open={context?.door_open ? "true" : "false"}>
            <span className="door2-state-dot" aria-hidden="true" />
            <strong>{context?.door_open ? "Puerta abierta" : "Puerta cerrada"}</strong>
            <small>
              {context
                ? `${context.assigned_door || "Sin acceso"} · ${context.capacity} de aforo`
                : "Sin estado del servidor"}
            </small>
          </div>
          <div className="door2-metrics">
            <div>
              <span>Dentro</span>
              <strong>{context?.inside ?? "—"}</strong>
              <small>ahora</small>
            </div>
            <div>
              <span>Ingresos</span>
              <strong>{context?.admitted ?? "—"}</strong>
              <small>acumulados</small>
            </div>
            <div>
              <span>Salidas</span>
              <strong>{context?.exits ?? "—"}</strong>
              <small>registradas</small>
            </div>
          </div>
        </section>

        {context?.zones?.length > 0 && (
          <section className="door2-zones" aria-label="Aforo por zona">
            <div className="door2-zones-head">
              <span>Aforo por zona</span>
              <small>
                {context.assigned_zone
                  ? `Tu puesto: ${context.assigned_zone.name}`
                  : "Todas las zonas"}
              </small>
            </div>
            {context.assigned_zone?.status === "full" && (
              <div className="door2-banner" data-tone="danger" role="alert">
                <Icon name="alert" className="h-4 w-4" />
                <span>
                  {context.assigned_zone.name} está lleno. No admitas más
                  ingresos a esta zona; redirigí a otra con cupo.
                </span>
              </div>
            )}
            {context.assigned_zone?.status === "near" && (
              <div className="door2-banner" data-tone="warn" role="status">
                <Icon name="alert" className="h-4 w-4" />
                <span>
                  {context.assigned_zone.name}: quedan{" "}
                  {context.assigned_zone.free_seats} lugares.
                </span>
              </div>
            )}
            <div className="door2-zone-list">
              {context.zones.map((zone) => (
                <div
                  key={zone.id}
                  className="door2-zone"
                  data-status={zone.status}
                  data-assigned={
                    context.assigned_zone?.id === zone.id ? "true" : undefined
                  }
                >
                  <div>
                    <strong>{zone.name}</strong>
                    <small>
                      {zone.inside}/{zone.capacity} adentro
                    </small>
                  </div>
                  <span>
                    {zone.status === "full"
                      ? "Lleno"
                      : `${zone.free_seats} libres`}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="door2-scanner-card" data-scanning={scanning ? "true" : "false"}>
          <div id="door2-qr-region" className="door2-qr-region" />
          {!scanning && !starting && (
            <div className="door2-scanner-cover">
              <div className="door2-scanner-icon">
                <Icon name="qr" className="h-9 w-9" />
              </div>
              <p>Apuntá al QR del invitado</p>
              <button
                type="button"
                className="door2-btn door2-btn--primary"
                onClick={startScanner}
              >
                <Icon name="camera" className="h-4 w-4" />
                Activar cámara
              </button>
            </div>
          )}
          {starting && (
            <div className="door2-scanner-cover">
              <span className="door2-spinner" aria-hidden="true" />
              <p>Preparando la cámara…</p>
            </div>
          )}
          {scanning && (
            <>
              <div className="door2-reticle" data-busy={validating ? "true" : "false"} aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </div>
              <div className="door2-scan-mode-chip">
                {scanMode === "in" ? "Entrada" : "Salida"}
              </div>
              <button type="button" className="door2-stop" onClick={stopScanner}>
                Detener cámara
              </button>
            </>
          )}
          {error && <p className="door2-scanner-error">{error}</p>}
        </section>

        <section className="door2-mode" role="group" aria-label="Qué se registra">
          <button
            type="button"
            data-active={scanMode === "in" ? "true" : "false"}
            onClick={() => setScanMode("in")}
          >
            <Icon name="check" className="h-4 w-4" />
            <span>
              <strong>Entrada</strong>
              <small>Validar ingreso</small>
            </span>
          </button>
          <button
            type="button"
            data-active={scanMode === "out" ? "true" : "false"}
            onClick={() => setScanMode("out")}
          >
            <Icon name="arrowRight" className="h-4 w-4" />
            <span>
              <strong>Salida</strong>
              <small>Liberar aforo</small>
            </span>
          </button>
        </section>
        <p className="door2-mode-note">
          {scanMode === "out"
            ? "La salida se registra con red. Sin conexión no se inventa: el aforo lo descuenta el servidor."
            : context?.allow_reentry
              ? "Este evento permite reingreso: una boleta que salió puede volver a entrar."
              : "Este evento no permite reingreso: la salida no habilita una nueva entrada."}
        </p>

        <nav className="door2-actions" aria-label="Acciones de Puerta">
          <button type="button" onClick={() => setPanel("manual")}>
            <span className="door2-action-icon"><Icon name="qr" className="h-5 w-5" /></span>
            <strong>Código manual</strong>
            <small>QR dañado</small>
          </button>
          <button type="button" onClick={openIncidentList}>
            <span className="door2-action-icon"><Icon name="flag" className="h-5 w-5" /></span>
            <strong>Incidencias</strong>
            <small>{openIncidents ? `${openIncidents} abiertas` : "Sin pendientes"}</small>
            {openIncidents > 0 && <span className="door2-badge">{openIncidents}</span>}
          </button>
          <button
            type="button"
            onClick={() => {
              setPanel("shift");
              loadShiftRequests();
            }}
          >
            <span className="door2-action-icon"><Icon name="clock" className="h-5 w-5" /></span>
            <strong>Turno</strong>
            <small>{authorized ? "Autorizado" : "Sin autorización"}</small>
          </button>
        </nav>
      </div>

      {result && (
        <ResultSheet
          result={result}
          onClose={closeResult}
          onIncident={openIncidentForResult}
        />
      )}

      {panel === "manual" && (
        <Sheet
          title="Código manual"
          subtitle={`${context?.assigned_door || "Puerta"} · ${scanMode === "in" ? "Entrada" : "Salida"}`}
          onClose={() => setPanel(null)}
        >
          <form className="door2-form" onSubmit={submitManual}>
            <label>
              Código del QR
              <input
                autoFocus
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder="Pegá o escribí el código"
                inputMode="text"
                autoComplete="off"
                spellCheck="false"
              />
            </label>
            <p className="door2-hint">
              Se valida contra esta noche y este puesto. No cambia la boleta ni
              el aforo por escribirlo a mano.
            </p>
            <button type="submit" className="door2-btn door2-btn--primary door2-btn--wide">
              {scanMode === "in" ? "Validar ingreso" : "Registrar salida"}
            </button>
          </form>
        </Sheet>
      )}

      {panel === "incidents" && (
        <Sheet
          title="Incidencias"
          subtitle={`${context?.event_name || "Evento"} · solo las de tu turno`}
          onClose={() => setPanel(null)}
        >
          {incidentView === "detail" && incidentDetail ? (
            <div className="door2-incident-detail">
              <button
                type="button"
                className="door2-link"
                onClick={() => {
                  setIncidentView("list");
                  setIncidentDetail(null);
                  loadIncidents();
                }}
              >
                <Icon name="back" className="h-4 w-4" /> Todas las incidencias
              </button>
              <div className="door2-incident-head">
                <span
                  className="door2-pill"
                  data-tone={INCIDENT_STATUS[incidentDetail.status]?.tone}
                >
                  {INCIDENT_STATUS[incidentDetail.status]?.label}
                </span>
                <span className="door2-mono">
                  {incidentDetail.ticket_ref || `#${incidentDetail.id}`}
                </span>
              </div>
              <h3>{incidentDetail.reason}</h3>
              {incidentDetail.note && <p>{incidentDetail.note}</p>}
              <dl className="door2-facts">
                <div><dt>Puesto</dt><dd>{incidentDetail.door_name || "—"}</dd></div>
                <div><dt>Abierta por</dt><dd>{incidentDetail.created_by_name}</dd></div>
                <div><dt>Hora</dt><dd>{dateTime(incidentDetail.created_at)}</dd></div>
                {incidentDetail.ticket_type_name && (
                  <div><dt>Boleta</dt><dd>{incidentDetail.ticket_type_name}</dd></div>
                )}
              </dl>
              {incidentDetail.resolution_guidance && (
                <div className="door2-guidance">
                  <span>Indicación de Administración</span>
                  <p>{incidentDetail.resolution_guidance}</p>
                </div>
              )}
              {context?.ops_contact_phone && (
                <div className="door2-contact">
                  <div>
                    <span>Contacto operativo</span>
                    <strong>{context.ops_contact_name || "Administración"}</strong>
                    <small>{context.ops_contact_phone}</small>
                  </div>
                  <div className="door2-contact-actions">
                    <a className="door2-btn door2-btn--soft" href={`tel:${context.ops_contact_phone}`}>
                      Llamar
                    </a>
                    <a
                      className="door2-btn door2-btn--soft"
                      href={waHref(context.ops_contact_phone, `Incidencia: ${incidentDetail.reason}`)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      WhatsApp
                    </a>
                  </div>
                </div>
              )}
              <div className="door2-thread">
                {incidentDetail.comments?.length === 0 && (
                  <p className="door2-hint">Todavía no hay respuestas.</p>
                )}
                {(incidentDetail.comments || []).map((c) => (
                  <div key={c.id} className="door2-comment" data-channel={c.channel}>
                    <div>
                      <strong>{c.author_name}</strong>
                      <span>
                        {c.author_role === "admin"
                          ? "Administración"
                          : c.author_role === "promotor"
                            ? "Promotor"
                            : "Puerta"}{" "}
                        · {clock(c.created_at)}
                      </span>
                    </div>
                    <p>{c.body}</p>
                  </div>
                ))}
              </div>
              {incidentDetail.can_comment && incidentDetail.status !== "resolved" && (
                <div className="door2-comment-form">
                  <textarea
                    value={incidentComment}
                    onChange={(e) => setIncidentComment(e.target.value)}
                    placeholder="Escribí el contexto para Administración o el promotor…"
                    rows={3}
                  />
                  <div className="door2-comment-actions">
                    <select
                      value={incidentChannel}
                      onChange={(e) => setIncidentChannel(e.target.value)}
                      aria-label="Canal del registro"
                    >
                      <option value="note">Nota</option>
                      <option value="call">Resultado de llamada</option>
                      <option value="whatsapp">Resultado de WhatsApp</option>
                    </select>
                    <button
                      type="button"
                      className="door2-btn door2-btn--primary"
                      disabled={incidentBusy || !incidentComment.trim()}
                      onClick={() => sendIncidentComment(incidentChannel)}
                    >
                      Enviar
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : incidentView === "new" ? (
            <form className="door2-form" onSubmit={createIncident}>
              <button
                type="button"
                className="door2-link"
                onClick={() => setIncidentView("list")}
              >
                <Icon name="back" className="h-4 w-4" /> Volver
              </button>
              <label>
                Motivo
                <select value={incidentReason} onChange={(e) => setIncidentReason(e.target.value)}>
                  {INCIDENT_REASONS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>
              <label>
                Qué pasó (opcional)
                <textarea
                  value={incidentNote}
                  onChange={(e) => setIncidentNote(e.target.value)}
                  rows={3}
                  placeholder="Contá lo que viste en la puerta. Sin datos de más: nombre y puesto alcanzan."
                />
              </label>
              {incidentTicket ? (
                <div className="door2-attached">
                  <Icon name="ticket" className="h-4 w-4" />
                  <span>Boleta {incidentTicket.ref}{incidentTicket.type ? ` · ${incidentTicket.type}` : ""}</span>
                  <button type="button" onClick={() => setIncidentTicket(null)} aria-label="Quitar boleta">
                    <Icon name="close" className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <p className="door2-hint">
                  Sin boleta adjunta: el caso igual queda para Administración.
                </p>
              )}
              <button
                type="submit"
                className="door2-btn door2-btn--primary door2-btn--wide"
                disabled={incidentBusy}
              >
                {offline ? "Guardar y enviar al reconectar" : "Reportar incidencia"}
              </button>
            </form>
          ) : (
            <>
              <button
                type="button"
                className="door2-btn door2-btn--soft door2-btn--wide"
                onClick={() => {
                  setIncidentTicket(null);
                  setIncidentNote("");
                  setIncidentView("new");
                }}
              >
                <Icon name="plus" className="h-4 w-4" />
                Reportar incidencia
              </button>
              {pendingIncidents > 0 && (
                <p className="door2-hint">
                  {pendingIncidents} incidencia(s) guardada(s) en el teléfono, esperando conexión.
                </p>
              )}
              <div className="door2-incident-list">
                {incidentLoading && <p className="door2-hint">Cargando…</p>}
                {!incidentLoading && incidents.length === 0 && (
                  <div className="door2-empty-small">
                    <Icon name="check" className="h-6 w-6" />
                    <strong>Ninguna incidencia del turno</strong>
                    <span>Si algo no cuadra en la puerta, reportalo acá.</span>
                  </div>
                )}
                {incidents.map((inc) => (
                  <button
                    type="button"
                    key={inc.id}
                    className="door2-incident-row"
                    onClick={() => loadIncident(inc.id)}
                  >
                    <span className="door2-pill" data-tone={INCIDENT_STATUS[inc.status]?.tone}>
                      {INCIDENT_STATUS[inc.status]?.label}
                    </span>
                    <strong>{inc.reason}</strong>
                    <small>
                      {inc.ticket_ref || `#${inc.id}`} · {clock(inc.created_at)}
                      {inc.ticket_type_name ? ` · ${inc.ticket_type_name}` : ""}
                    </small>
                    <Icon name="chevronDown" className="h-4 w-4 door2-incident-chevron" />
                  </button>
                ))}
              </div>
            </>
          )}
        </Sheet>
      )}

      {panel === "shift" && (
        <Sheet
          title="Turno"
          subtitle={`${context?.event_name || "Evento"} · ${context?.assigned_door || "Sin puesto"}`}
          onClose={() => setPanel(null)}
        >
          <div className="door2-auth-card" data-authorized={authorized ? "true" : "false"}>
            <div className="door2-auth-head">
              <span className="door2-auth-icon">
                <Icon name={authorized ? "shield" : "lock"} className="h-5 w-5" />
              </span>
              <div>
                <strong>{authorized ? "Teléfono autorizado" : "Sin autorización de dispositivo"}</strong>
                <span>
                  {authorized
                    ? `${device?.door_name || context?.assigned_door || "Puerta"} · ${device?.phone || user?.phone || "sin teléfono registrado"}`
                    : "Abrí el link de Puerta de este puesto para poder escanear."}
                </span>
              </div>
            </div>
            <dl className="door2-facts">
              <div><dt>Evento</dt><dd>{context?.event_name || selectedEventData?.name || "—"}</dd></div>
              <div><dt>Puesto</dt><dd>{context?.assigned_door || device?.door_name || "—"}</dd></div>
              <div>
                <dt>Turno</dt>
                <dd>
                  {context?.shift_start || context?.shift_end
                    ? `${clock(context.shift_start)} – ${clock(context.shift_end)}`
                    : "Toda la noche"}
                </dd>
              </div>
              <div><dt>Vence</dt><dd>{dateTime(device?.expires_at || context?.device?.expires_at)}</dd></div>
              <div><dt>Última lectura</dt><dd>{dateTime(context?.last_verified_at)}</dd></div>
              <div><dt>Incidencias abiertas</dt><dd>{openIncidents}</dd></div>
            </dl>
            {!authorized && (
              <button type="button" className="door2-btn door2-btn--soft" onClick={clearAuthorization}>
                Borrar credencial de este teléfono
              </button>
            )}
          </div>

          {!fijo && events?.length > 1 && (
            <div className="door2-field-block">
              <label>
                Evento de esta noche
                <select
                  value={selectedEvent || ""}
                  onChange={(e) => setSelectedEvent(Number(e.target.value) || null)}
                >
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>{ev.name}</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div className="door2-offline-card">
            <div>
              <p className="door2-card-kicker">Modo sin conexión</p>
              <strong>
                {snapInfo ? `${snapInfo.count} boletas listas` : "Sin caché descargado"}
              </strong>
              <span>
                {snapInfo
                  ? `Actualizado ${dateTime(snapInfo.generated_at)}.`
                  : "Descargalo con red antes de que falle la señal del recinto."}
              </span>
            </div>
            <div className="door2-counter-row">
              <span><b>{pendingScans}</b> ingresos</span>
              <span><b>{pendingIncidents}</b> incidencias</span>
            </div>
            <div className="door2-inline-actions">
              <button type="button" className="door2-btn door2-btn--soft" onClick={prepareOffline}>
                {snapInfo ? "Actualizar caché" : "Preparar sin conexión"}
              </button>
              {(pendingScans > 0 || pendingIncidents > 0) && (
                <button
                  type="button"
                  className="door2-btn door2-btn--primary"
                  onClick={doSync}
                  disabled={syncing || offline}
                >
                  {syncing ? "Sincronizando…" : "Sincronizar ahora"}
                </button>
              )}
            </div>
          </div>

          <div className="door2-shift-card">
            <div className="door2-shift-head">
              <div>
                <p className="door2-card-kicker">Relevo</p>
                <strong>Cambio de teléfono o de persona</strong>
              </div>
              <button
                type="button"
                className="door2-btn door2-btn--soft"
                onClick={() => setShiftForm((v) => !v)}
              >
                {shiftForm ? "Cancelar" : "Solicitar"}
              </button>
            </div>
            {shiftForm ? (
              <form className="door2-form" onSubmit={requestShift}>
                <label>
                  Motivo
                  <input
                    value={shiftReason}
                    onChange={(e) => setShiftReason(e.target.value)}
                    placeholder="Ej: termina mi turno a las 2:00"
                    required
                    minLength={3}
                  />
                </label>
                <label>
                  Teléfono del relevo (opcional)
                  <input
                    value={shiftPhone}
                    onChange={(e) => setShiftPhone(e.target.value)}
                    placeholder="300 123 4567"
                    inputMode="tel"
                  />
                </label>
                <p className="door2-hint">
                  Administración aprueba, transfiere o revoca el puesto. El
                  teléfono anterior deja de registrar operaciones.
                </p>
                <button type="submit" className="door2-btn door2-btn--primary door2-btn--wide">
                  Enviar solicitud
                </button>
              </form>
            ) : (
              <div className="door2-shift-list">
                {shiftRequests.length === 0 && (
                  <p className="door2-hint">Sin solicitudes en esta noche.</p>
                )}
                {shiftRequests.map((r) => (
                  <div key={r.id} className="door2-shift-row">
                    <span className="door2-pill" data-tone={r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}>
                      {r.status === "approved" ? "Aprobado" : r.status === "rejected" ? "Rechazado" : "Pendiente"}
                    </span>
                    <strong>{r.reason}</strong>
                    <small>{clock(r.created_at)}{r.reviewed_by_name ? ` · revisó ${r.reviewed_by_name}` : ""}</small>
                  </div>
                ))}
              </div>
            )}
          </div>

          {context?.ops_contact_phone && (
            <div className="door2-contact">
              <div>
                <span>Contacto operativo</span>
                <strong>{context.ops_contact_name || "Administración"}</strong>
                <small>{context.ops_contact_phone}</small>
              </div>
              <div className="door2-contact-actions">
                <a className="door2-btn door2-btn--soft" href={`tel:${context.ops_contact_phone}`}>
                  Llamar
                </a>
                <a
                  className="door2-btn door2-btn--soft"
                  href={waHref(context.ops_contact_phone, "Consulta desde Puerta")}
                  target="_blank"
                  rel="noreferrer"
                >
                  WhatsApp
                </a>
              </div>
            </div>
          )}
        </Sheet>
      )}
    </main>
  );
}
