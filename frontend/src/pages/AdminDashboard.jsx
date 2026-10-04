import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiFetch, publicTicketPageUrl } from "../lib/api";
import ContactEditsHistory from "../components/ContactEditsHistory";
import { useAuth } from "../lib/auth";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { haptics } from "../lib/haptics";
import ReportWidget from "../components/ReportWidget";
import { LiveIndicator, QuotaMeter } from "../components/Brand";
import { STATUS_META as EV_CHIP } from "../components/EventWorkbench";
import { PullToRefresh } from "../components/PullToRefresh";
import { InstallPrompt } from "../components/InstallPrompt";
import {
  ListSkeleton,
  SelectSkeleton,
  Skeleton,
  StatSkeletonRow,
} from "../components/Skeleton";
import { useUI } from "../lib/ui";
import { activeVenueId } from "../lib/venue";
import { money } from "../lib/format";
import CountUpNumber from "../components/CountUpNumber";

import EmptyState from "../components/EmptyState";
import { OnboardingChecklist } from "../components/OnboardingChecklist";
import EventWorkbench, {
  EventNotFound,
  sortEventsForStrip,
} from "../components/EventWorkbench";
import Icon from "../components/Icon";
import { Star4, Bolt, RibbonDivider } from "../components/Doodles";
import TeamManager from "../components/TeamManager";
import InvitationsManager from "../components/InvitationsManager";
import PayoutsManager from "../components/PayoutsManager";
import TypeManager from "../components/TypeManager";
import AllocationManager from "../components/AllocationManager";
import TicketList from "../components/TicketList";
import EventTeamPanel from "../components/EventTeamPanel";
import EventCreateModal from "../components/EventCreateModal";
import QrTesterModal from "../components/QrTesterModal";
import BusinessOverview from "../components/BusinessOverview";
import BusinessDock from "../components/BusinessDock";
import PaymentsPanel from "../components/PaymentsPanel";
import VenueHeader from "../components/VenueHeader";

function firstVenueId(user) {
  // Multi-negocio: la activa se elige en /perfil y persiste (tf_venue);
  // sin elección, la primera disponible (comportamiento de siempre).
  return activeVenueId(user);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Date -> valor para <input type="datetime-local"> (hora LOCAL, sin zona). */
function toLocalInput(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/** Fecha corta para la franja de eventos (los chips no dan para más). */
function formatShortDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-CO", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Minuto del día 0-1439 -> etiqueta "8 p.m." (para la píldora de apertura). */
function minuteLabel(mins) {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const suf = h24 >= 12 ? "p.m." : "a.m.";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return m ? `${h}:${String(m).padStart(2, "0")} ${suf}` : `${h} ${suf}`;
}

/** Diferencia de dias de CALENDARIO (no de 24h): un evento de hoy a las
    11 p.m. dista 0.9 dias de la medianoche y un round() lo mandaria a
    "mañana". Comparar año/mes/dia evita ese classico. */
function calendarDiffDays(a, b) {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ua - ub) / 86400000);
}

/** Píldora de apertura del evento: "Hoy 8 p.m." / "Vie 8 p.m." / pasado. */
function openingPill(startsAt) {
  if (!startsAt) return null;
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const mins = d.getHours() * 60 + d.getMinutes();
  const time = minuteLabel(mins);
  const diffDays = calendarDiffDays(d, now);
  if (diffDays === 0) return { main: `Hoy ${time}`, tone: "today" };
  if (diffDays === 1) return { main: `Mañana ${time}`, tone: "soon" };
  if (diffDays < 0)
    return {
      main: d.toLocaleDateString("es-CO", { day: "numeric", month: "short" }),
      tone: "past",
    };
  return {
    main: `${d.toLocaleDateString("es-CO", {
      weekday: "short",
    })} ${time}`,
    tone: diffDays <= 3 ? "soon" : "far",
  };
}

const NEXT_ACTIONS = {
  draft: [
    { action: "publish", label: "Publicar evento" },
    { action: "cancel", label: "Cancelar", danger: true },
  ],
  published: [
    { action: "live", label: "Abrir puertas" },
    { action: "cancel", label: "Cancelar evento", danger: true },
  ],
  live: [{ action: "end", label: "Finalizar evento" }],
  ended: [],
  cancelled: [],
};

/* Chip de estado para la franja de eventos (compacto, en español) y orden
 * por prioridad operativa: vivos arriba, pasados al final. Ambos viven en
 * EventWorkbench — un solo vocabulario de estados en toda la app. */

/** Color del punto/estado por ciclo de vida. Un solo mapa para la franja y
 * el backstage: el mismo estado siempre representa con el mismo tono. */
export const STATUS_DOT_COLOR = {
  live: "#34d399",
  // "A la venta" va en crema, NO en el naranja de la CTA: si comparte color
  // con el boton de accion, la etiqueta de estado se lee como un boton.
  published: "#f5e6c8",
  draft: "#71717a",
  ended: "#a1a1aa",
  cancelled: "#dc2626",
};

/**
 * Espejo de la regla del backend (lifecycle.delete_event): se borra cualquier
 * evento salvo el que tiene las puertas abiertas (se está operando ahora).
 * Para limpiar un catálogo de pruebas no hace falta vaciar boletas a mano.
 */
export function canDeleteEvent(ev) {
  return !!ev && ev.status !== "live";
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const ui = useUI();
  const venueId = firstVenueId(user);

  const [events, setEvents] = useState(null); // null = primera carga (skeleton)
  // Boletas activas por evento ({id: n}): el pulso de la franja sin abrir
  // cada evento. Un solo GET agregado, no N requests.
  const [ticketCounts, setTicketCounts] = useState({});
  const [types, setTypes] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [report, setReport] = useState(null);
  const [users, setUsers] = useState([]);
  // tickets: el listado real vive en TicketList (server-driven, paginado).
  // El fetch que llenaba este estado quedó muerto: nadie lo lee. Solo setTickets
  // se usa para limpiar al cambiar de evento — por eso este useState se queda.
  const [tickets, setTickets] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  // Fuente de verdad de la URL: el evento abierto y su pestaña viven en
  // /admin?event=<id>&tab=<tab> — compartible, sobrevive recargas y back.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlEvent = searchParams.get("event");
  const urlTab = searchParams.get("tab") || "resumen";
  const [error, setError] = useState("");
  // Modal de crear evento: cerrado por defecto — el admin trabaja en su
  // evento, no mira un formulario gigante todo el día.
  const [createOpen, setCreateOpen] = useState(false);
  // Probador de QR: leer un QR y ver a quién pertenece SIN canjearlo.
  const [qrTesterOpen, setQrTesterOpen] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  // Edición del evento seleccionado: null = cerrado, objeto = formulario abierto.
  const [editingEvent, setEditingEvent] = useState(null);
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  // La pestaña activa es la de la URL (la mig 012 ya generaba ?tab=...);
  // whitelist para no renderizar una pestaña inventada por el usuario.
  const section = [
    "resumen",
    "entradas",
    "cupos",
    "boletas",
    "noche",
    "cobros",
    "negocio",
    "equipo",
    "liquidaciones",
    "invitaciones",
  ].includes(urlTab)
    ? urlTab
    : "resumen";

  // events === null significa "primera carga": se muestra skeleton en vez de
  // un vacío engañoso ("Aún no hay eventos") que no es verdad aún.
  const booting = events === null;

  // Franja de eventos: búsqueda por nombre y filtro por estado. Es client-side
  // a propósito: el catálogo ya vive en memoria y pedirlo al server por cada
  // tecla sería desperdicio (y más lento que filtrar 50 objetos).
  const [eventQuery, setEventQuery] = useState("");
  const [eventBucket, setEventBucket] = useState("todos");
  // Densidad de la franja: tarjetas (default) o lista compacta. Con 20+
  // eventos la grilla exige scroll infinito; la tabla responde de un vistazo.
  // Persistida: la preferencia de densidad es del usuario, no de la sesión.
  const [compactView, setCompactView] = useState(
    () => localStorage.getItem("tf_ev_compact") === "1",
  );
  useEffect(() => {
    localStorage.setItem("tf_ev_compact", compactView ? "1" : "0");
  }, [compactView]);
  // Id del evento duplicándose ahora (spinner in situ en SU tarjeta).
  const [dupingId, setDupingId] = useState(null);
  // Id del evento eliminándose ahora (spinner in situ en SU tarjeta/fila).
  const [deletingId, setDeletingId] = useState(null);
  // Flyers que ya fallaron al cargar ({url: true}): la tarjeta muestra sus
  // iniciales en lugar de un img roto. Estado unificado para toda la franja.
  const [badFlyers, setBadFlyers] = useState({});

  const BUCKETS = [
    ["todos", "Todos"],
    ["live", "En puerta"],
    ["published", "A la venta"],
    ["draft", "Borradores"],
    ["ended", "Terminados"],
    ["cancelled", "Cancelados"],
  ];
  const q = eventQuery.trim().toLowerCase();
  const visibleEvents = (events ?? []).filter(
    (ev) =>
      (eventBucket === "todos" || ev.status === eventBucket) &&
      (!q || ev.name.toLowerCase().includes(q)),
  );

  const loadEvents = useCallback(async () => {
    if (!venueId) return;
    const data = await apiFetch(`/venues/${venueId}/events`);
    setEvents(data);
    // Contadores de la franja: fire-and-forget (si falla, la franja muestra
    // su chip vacío; no rompe el listado que ya llegó).
    apiFetch(`/venues/${venueId}/events/ticket-counts`)
      .then(setTicketCounts)
      .catch(() => {});
  }, [venueId]);

  useEffect(() => {
    loadEvents().catch((e) => setError(e.message));
  }, [loadEvents]);

  // Sincronización URL <-> selección. La URL manda si trae evento válido;
  // sin evento en la URL, se aterriza en el primero (determinismo: la
  // recarga con /admin a secas abre el mismo evento, no una pantalla vacía).
  // Con eventos === null aún no se sabe si existe el de la URL: no tocar nada.
  useEffect(() => {
    if (events === null) return;
    const wanted = urlEvent ? Number(urlEvent) : null;
    const exists = wanted !== null && events.some((e) => e.id === wanted);
    if (exists) {
      if (wanted !== selectedEvent) setSelectedEvent(wanted); // Enlace viejo con pestaña de venue dentro de un evento
      // (?event=5&tab=equipo): esas pestañas no existen en el backstage —
      // se normaliza al evento sin tab (aterriza en Resumen).
      if (
        urlTab &&
        ["negocio", "equipo", "liquidaciones", "invitaciones"].includes(urlTab)
      ) {
        setSearchParams({ event: String(wanted) });
      }
    } else if (urlEvent) {
      // Evento inexistente en la URL (borrado/enlace viejo): se limpia el
      // parámetro para que la URL diga la verdad de lo que se está viendo.
      setSearchParams({});
    } else if (selectedEvent !== null) {
      // Sin ?event= en la URL: la lista es la pantalla (modo lista). Nadie
      // aterriza "en el primer evento" por accidente: entrar es una decisión.
      setSelectedEvent(null);
    } else if (events.length === 0 && !createOpen) {
      // Venue nueva sin eventos: la única acción posible es crear el primero.
      setCreateOpen(true);
    }
    // selectedEvent a propósito fuera de las deps: esta pantalla solo sigue a
    // la URL y al catálogo, no re-detecciona en cada clic del selector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, urlEvent]);

  /** Navega al backstage de un evento (la URL es la fuente de verdad). */
  function flyToEvent(id, tab) {
    const params = new URLSearchParams();
    params.set("event", String(id));
    if (tab && tab !== "resumen") params.set("tab", tab);
    setSearchParams(params); // push: back vuelve al evento/tab anterior
  }

  /** Duplica un evento (borrador con sus tipos y cupos). */
  async function duplicateEvent(ev) {
    setDupingId(ev.id);
    try {
      const copy = await apiFetch(
        `/venues/${venueId}/events/${ev.id}/duplicate`,
        { method: "POST" },
      );
      await loadEvents();
      // NO se salta al backstage del borrador: con 20+ noches, duplicar una
      // tras otra y que cada clic te expulse de la lista rompe el flujo. El
      // borrador aparece arriba y el aviso dice que abrir.
      ui.success(`Borrador "${copy.name}" creado: ajustá la fecha y publicá 📋`);
    } catch (err) {
      setError(err.message);
    } finally {
      setDupingId(null);
    }
  }

  /** Cambia de pestaña dentro del backstage del evento abierto. */
  function setSection(tab) {
    flyToEvent(selectedEvent, tab);
  }

  // Usuarios de la venue: para asignar cupos con nombres reales
  const reloadUsers = useCallback(() => {
    if (!venueId) return Promise.resolve();
    return apiFetch(`/venues/${venueId}/users?include_inactive=true`)
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [venueId]);
  useEffect(() => {
    reloadUsers();
  }, [reloadUsers]);

  useEffect(() => {
    if (!selectedEvent) return;
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/types`)
      .then(setTypes)
      .catch((e) => setError(e.message));
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/allocations`)
      .then(setAllocations)
      .catch((e) => setError(e.message));
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/report`)
      .then(setReport)
      .catch((e) => setError(e.message));
    // El listado de boletas NO se pide aquí: TicketList trae el suyo paginado
    // y filtrado. Pedir el completo era una request muerta (nadie lee el
    // estado `tickets`) que además traía TODAS las boletas del evento.
  }, [selectedEvent, venueId]);

  // Memoizado: es dependencia de reloadAll (PTR) y de useLiveRefresh; sin
  // memo, ambas corren con una closure vieja cuando cambia el evento elegido.
  const refreshEventData = useCallback(async () => {
    if (!selectedEvent) return;
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/report`)
      .then(setReport)
      .catch(() => {});
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/allocations`)
      .then(setAllocations)
      .catch(() => {});
    // El pulso de la franja también vive: en puerta cambia con cada escaneo.
    apiFetch(`/venues/${venueId}/events/ticket-counts`)
      .then(setTicketCounts)
      .catch(() => {});
    // Nota: el listado de boletas no va aquí — TicketList se refresca sola
    // (su load es el refresh local de la tabla).
  }, [selectedEvent, venueId]);

  // Recarga completa para pull-to-refresh: eventos, equipo y datos del evento
  // seleccionado. Nunca lanza: el PTR solo necesita terminar.
  const reloadAll = useCallback(async () => {
    await Promise.allSettled([loadEvents(), reloadUsers(), refreshEventData()]);
    // refreshEventData ya cubre selectedEvent/venueId; si falta alguna dep,
    // el PTR refrescaría datos de un evento que ya no está seleccionado.
  }, [loadEvents, reloadUsers, refreshEventData]);

  async function runAction(action, label) {
    if (!selectedEvent) return;
    // Pre-vuelo también en el backstage (la misma apertura, otro camino).
    if (action === "live") {
      try {
        const pf = await apiFetch(
          `/venues/${venueId}/events/${selectedEvent}/preflight`,
        );
        if (pf.bouncers === 0) {
          const ok0 = await ui.confirm("¿Abrir puertas sin nadie en puerta?", {
            message:
              "Esta noche no tiene nadie asignado en puerta. Podés sumar a alguien en la pestaña Equipo antes de abrir.",
            confirmLabel: "Abrir igual",
            danger: true,
          });
          if (!ok0) {
            setSection("noche");
            return;
          }
        } else if (!pf.door_ready) {
          const names = pf.door_staff.map((s) => s.full_name).join(", ");
          const ok1 = await ui.confirm("¿Abrir puertas sin escáner activo?", {
            message: `${names} aún no abrió su link de puerta. Sin canjearlo no podrá escanear esta noche.`,
            confirmLabel: "Abrir igual",
          });
          if (!ok1) {
            setSection("noche");
            return;
          }
        }
      } catch {
        // Sin pre-vuelo no se bloquea la apertura.
      }
    }
    if (action === "cancel") {
      const ok = await ui.confirm("¿Cancelar el evento?", {
        message:
          "Las boletas emitidas dejarán de ser válidas en la puerta y no se podrá revertir.",
        danger: true,
        confirmLabel: "Sí, cancelar evento",
      });
      if (!ok) return;
    }
    if (action === "end") {
      const ok = await ui.confirm("¿Finalizar el evento?", {
        message: "La puerta dejará de aceptar escaneos.",
        confirmLabel: "Finalizar",
      });
      if (!ok) return;
    }
    setBusyAction(action);
    setError("");
    try {
      const updated = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/${action}`,
        {
          method: "POST",
        },
      );
      setEvents((evs) => evs.map((e) => (e.id === updated.id ? updated : e)));
      await refreshEventData();
      ui.success(
        action === "publish"
          ? "Evento publicado: ya puede vender 🎟️"
          : action === "live"
            ? "Puertas abiertas: la puerta fue avisada 🚪"
            : action === "end"
              ? "Evento finalizado"
              : "Evento cancelado",
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  /** Transición de ciclo de vida DESDE LA FRANJA: la tarjeta se convierte en
      panel de control. Publicar (draft) y Abrir puertas (published) son las
      dos que desbloquean dinero y puerta; cancelar/finalizar quedan en el
      backstage porque piden contexto (cifras, boletas). */
  async function quickTransition(ev, action) {
    const labels = { publish: "¿Publicar el evento?", live: "¿Abrir puertas?" };
    const done = {
      publish: "Evento publicado: ya puede vender 🎟️",
      live: "Puertas abiertas: la puerta fue avisada 🚪",
    };
    // PRE-VUELO: abrir puertas sin nadie en puerta era el fracaso silencioso
    // (el evento pasa a live y el escáner rechaza con 403). El pre-vuelo lo
    // dice ANTES del confirm, con los nombres, y deja seguir si el admin
    // decide que así sea.
    if (action === "live") {
      try {
        const pf = await apiFetch(
          `/venues/${venueId}/events/${ev.id}/preflight`,
        );
        if (pf.bouncers === 0) {
          const ok0 = await ui.confirm("¿Abrir puertas sin nadie en puerta?", {
            message:
              "Esta noche no tiene nadie asignado en puerta. La boletería funciona, pero no habrá quien escanee. Podés sumar a alguien en la pestaña Equipo de la noche.",
            confirmLabel: "Abrir igual",
            danger: true,
          });
          if (!ok0) {
            flyToEvent(ev.id, "noche");
            return;
          }
        } else if (!pf.door_ready) {
          const names = pf.door_staff.map((s) => s.full_name).join(", ");
          const ok1 = await ui.confirm(
            `¿Abrir puertas sin escáner activo?`,
            {
              message: `${names} ${pf.bouncers === 1 ? "está" : "están"} asignado${pf.bouncers === 1 ? "" : "s"} a puerta pero nadie abrió su link todavía. Sin canjear el link no van a poder escanear esta noche.`,
              confirmLabel: "Abrir igual",
            },
          );
          if (!ok1) {
            flyToEvent(ev.id, "noche");
            return;
          }
        }
      } catch {
        // Pre-vuelo caído: no bloquea la apertura (el negocio decide igual).
      }
    }
    const ok = await ui.confirm(labels[action], {
      message:
        action === "publish"
          ? "El evento pasa a la venta: los promotores pueden emitir boletas."
          : "La puerta empieza a aceptar escaneos.",
      confirmLabel: action === "publish" ? "Publicar" : "Abrir puertas",
    });
    if (!ok) return;
    setBusyAction(`${action}-${ev.id}`);
    setError("");
    try {
      const updated = await apiFetch(
        `/venues/${venueId}/events/${ev.id}/${action}`,
        { method: "POST" },
      );
      setEvents((evs) => evs.map((e) => (e.id === updated.id ? updated : e)));
      haptics.success();
      ui.success(done[action]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  function startEditEvent() {
    const ev = selectedEventData;
    setEditError("");
    setEditingEvent({
      name: ev.name ?? "",
      description: ev.description ?? "",
      flyer_url: ev.flyer_url ?? "",
      location: ev.location ?? "",
      starts_at: toLocalInput(new Date(ev.starts_at)),
      ends_at: ev.ends_at ? toLocalInput(new Date(ev.ends_at)) : "",
      capacity: String(ev.capacity),
      qr_unlock_minutes: String(ev.qr_unlock_minutes ?? 60),
    });
  }

  async function saveEventEdit(e) {
    e.preventDefault();
    setEditError("");

    const startsAt = new Date(editingEvent.starts_at);
    if (Number.isNaN(startsAt.getTime())) {
      setEditError("Elige una fecha y hora de apertura valida.");
      return;
    }
    const endsAt = editingEvent.ends_at ? new Date(editingEvent.ends_at) : null;
    if (endsAt && Number.isNaN(endsAt.getTime())) {
      setEditError("La fecha de cierre no es valida.");
      return;
    }
    if (endsAt && endsAt <= startsAt) {
      setEditError("El cierre debe ser posterior a la apertura.");
      return;
    }
    const capacity = Number(editingEvent.capacity);
    if (!Number.isInteger(capacity) || capacity < 1) {
      setEditError("El aforo debe ser un entero mayor que cero.");
      return;
    }

    setSavingEdit(true);
    try {
      const updated = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: editingEvent.name.trim(),
            capacity,
            qr_unlock_minutes: Number(editingEvent.qr_unlock_minutes),
            starts_at: startsAt.toISOString(),
            ends_at: endsAt ? endsAt.toISOString() : null,
            description: editingEvent.description.trim() || null,
            flyer_url: editingEvent.flyer_url.trim() || null,
            location: editingEvent.location.trim() || null,
          }),
        },
      );
      setEvents((evs) => evs.map((x) => (x.id === updated.id ? updated : x)));
      setEditingEvent(null);
      ui.success("Cambios guardados");
    } catch (err) {
      setEditError(err.message);
    } finally {
      setSavingEdit(false);
    }
  }

  /**
   * Elimina un evento desde donde se dispare: la lista (tarjeta/fila) o el
   * backstage. El backend exige el nombre exacto como confirmación y solo lo
   * permite en borrador o sin boletas emitidas: aquí solo traducimos.
   */
  async function deleteEvent(ev) {
    if (!ev) return;
    const confirm = await ui.prompt(`Eliminar "${ev.name}"`, {
      message:
        "Se borran también sus tipos, cupos, boletas y pagos. Esta acción no tiene deshacer.\nEscribe el nombre del evento para confirmar:",
      placeholder: ev.name,
      danger: true,
      confirmLabel: "Eliminar definitivamente",
    });
    if (confirm === null) return;
    setError("");
    setDeletingId(ev.id);
    try {
      await apiFetch(`/venues/${venueId}/events/${ev.id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm }),
      });
      // Si el evento borrado era el que estaba abierto, salir del backstage
      // (sin tocar la URL si se borró desde la lista: ahí no hay ?event=).
      if (selectedEvent === ev.id) {
        setSelectedEvent(null);
        setSearchParams({});
      }
      await loadEvents();
      ui.success("Evento eliminado");
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  }

  function deleteSelectedEvent() {
    return deleteEvent(selectedEventData);
  }

  const selectedEventData = (events ?? []).find(
    (ev) => ev.id === selectedEvent,
  );
  const actions = selectedEventData
    ? (NEXT_ACTIONS[selectedEventData.status] ?? [])
    : [];
  const editable =
    selectedEventData &&
    ["draft", "published"].includes(selectedEventData.status);

  // Auto-refresh en puerta (live): el reporte cambia con los escaneos de la
  // puerta, así que el admin no debería tener que recargar para ver el aforo.
  // El hook pausa el intervalo con la pestaña oculta y refresca al volver.
  const isLive = selectedEventData?.status === "live";
  const lastUpdated = useLiveRefresh(refreshEventData, isLive);

  // Píldora de turno (tanda 3): quién está en puerta AHORA y si su escáner
  // está activo. Se pide con el resto de los datos del evento; si el endpoint
  // falla, la píldora simplemente no aparece (es información, no control).
  const [preflight, setPreflight] = useState(null);
  useEffect(() => {
    if (!selectedEvent) {
      setPreflight(null);
      return;
    }
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/preflight`)
      .then(setPreflight)
      .catch(() => setPreflight(null));
  }, [selectedEvent, venueId]);

  // Cierre de noche (tanda 3): el botón aparece en el backstage; si el evento
  // tiene boletas o escaneos, hay algo que cerrar. Fallar la descarga no
  // rompe el panel: el CSV se puede reintentar.
  const closing = !!selectedEventData;
  async function closeNight() {
    setError("");
    try {
      const token = localStorage.getItem("tf_token");
      const res = await fetch(
        `/api/venues/${venueId}/events/${selectedEvent}/closing.csv`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error("No se pudo exportar el cierre");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `cierre-evento-${selectedEvent}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      ui.success("Cierre descargado");
    } catch (err) {
      setError(err.message);
    }
  }

  if (!venueId) {
    return (
      <div className="card p-6 text-center text-zinc-400">
        No tienes venues asociadas. Habla con un super admin.
      </div>
    );
  }

  return (
    <PullToRefresh onRefresh={reloadAll}>
      <div className="reveal space-y-5">
        {/* En móvil: invita a instalar la PWA (se oculta sola si ya está instalada) */}
        <InstallPrompt />
        {/* Guía del admin primerizo: SOLO mientras la venue es nueva (sin
          eventos). Con negocio operando era ruido permanente: un checklist
          "Crea tu primer evento" sobre una lista llena de eventos. */}
        {events !== null && events.length === 0 && (
          <OnboardingChecklist
            hasEvent={false}
            hasTypes={types.length > 0}
            hasAllocations={allocations.length > 0}
            isPublished={false}
            onStart={() => setCreateOpen(true)}
          />
        )}{" "}
        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
        {/* =================================================================
            MODO LISTA: sin evento abierto. El mapa de la operación. Aquí es
            el único lugar donde existen "todos los eventos": se elige uno y
            se ENTRA — el backstage no comparte pantalla con la lista.
            ================================================================= */}
        {!selectedEventData && (
          <>
            {/* PORTADA UNIFICADA: identidad + cifra del mes + eventos viven en
              el MISMO card. Antes eran dos boxes apiladas que competían por
              ser "la cabecera"; aquí hay una sola portada con una sola línea
              de lectura: quién eres → cuánto va el mes → tus noches. */}
            <VenueHeader venueId={venueId} user={user}>
              {/* PORTADA UNIFICADA: la franja de eventos vive DENTRO del card
                de la venue — un solo contexto como Del negocio, secciones
                separadas por hairline. Sin evento abierto no hay segundo
                bloque que compita por ser "la cabecera". */}
              {booting
                ? null
                : events.length > 0 && (
                    <>
                      {/* Cabecera de sección DENTRO de la portada: mismo
                        idioma del dock Del negocio (eyebrow + display + la
                        acción principal a la derecha, ENCIMA de la barra de
                        búsqueda). */}
                      <div className="evx-head doodle-host">
                        {/* Doodle de fiesta junto al titular (capa POP) */}
                        <Star4 className="-left-1 -top-1 h-3.5 w-3.5 text-[#f0f542]" />
                        <div className="min-w-0">
                          <p className="eyebrow">Operación</p>
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                            <h2 className="display text-xl sm:text-2xl">
                              <span className="brush-mark">Eventos</span>
                            </h2>
                            <p className="text-xs text-zinc-500">
                              {events.length} noche{events.length === 1 ? "" : "s"} en el calendario
                            </p>
                          </div>
                        </div>
                        {/* Nuevo evento: en móvil el verbo completo no entra sin
                            partirse en dos líneas y empujar el contador de la
                            franja; ahí queda el ícono solo (44x44, con
                            aria-label), que es el gesto que ya se reconoce. */}
                        <button
                          onClick={() => setCreateOpen(true)}
                          aria-label="Nuevo evento"
                          data-tip="Nuevo evento"
                          className="btn-primary evx-newbtn shrink-0"
                        >
                          <Icon name="plus" className="h-4 w-4" />
                          {/* El verbo aparece a 1024px, el mismo breakpoint
                              en que la barra vuelve a ser de una fila: antes
                              de eso el boton es solo el icono (CSS .evx-newbtn). */}
                          <span className="hidden lg:inline">
                            Nuevo evento
                          </span>
                        </button>
                      </div>
                      <div className="evx-toolbar">
                        {/* El buscador en su PROPIA fila en móvil. Antes
                            compartia fila con los filtros y terminaba con
                            54px de caja (40 de padding para la lupa): el
                            placeholder era invisible y la lupa se montaba
                            sobre la primera pestaña. Medido a 320/390/414px. */}
                        <div className="evx-search">
                          <Icon
                            name="search"
                            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                          />
                          <input
                            value={eventQuery}
                            onChange={(e) => setEventQuery(e.target.value)}
                            placeholder="Buscar evento…"
                            aria-label="Buscar evento por nombre"
                            className="field !py-2 !pl-10 text-sm"
                          />
                        </div>
                        {/* Densidad: tarjetas para pocas noches, tabla de una línea
                    cuando la lista crece (20+ eventos no caben en grilla).
                    Comparte la fila del buscador, no la de los filtros: ahí
                    competía por el mismo ancho. */}
                        <button
                          onClick={() => {
                            haptics.tick();
                            setCompactView((v) => !v);
                          }}
                          aria-pressed={compactView}
                          aria-label={
                            compactView
                              ? "Cambiar a vista de tarjetas"
                              : "Cambiar a vista compacta"
                          }
                          data-tip={
                            compactView
                              ? "Ver como tarjetas"
                              : "Ver como lista compacta"
                          }
                          className="btn-mini btn-icon shrink-0"
                          data-variant="brand"
                        >
                          <Icon
                            name={compactView ? "calendar" : "list"}
                            className="h-3.5 w-3.5"
                          />
                        </button>
                        {/* Filtros como tabs de texto (no píldoras con borde):
                    el estado activo se dice con tinta, no con otra caja. En
                    móvil van en fila propia con scroll-snap: son 6 estados y
                    con el buscador al lado solo entraban 2 a la vista, sin
                    ninguna pista de que la fila scrolleara. La pista se pinta
                    con la mascara de desvanecido (solo en móvil, que es donde
                    hay algo que scrollear de verdad). */}
                        <div
                          className="evx-filters"
                          role="tablist"
                          aria-label="Filtrar eventos por estado"
                        >
                          <div className="no-scrollbar evx-filters-row">
                            {BUCKETS.map(([id, label]) => {
                              const n =
                                id === "todos"
                                  ? events.length
                                  : events.filter((ev) => ev.status === id)
                                      .length;
                              const active = eventBucket === id;
                              return (
                                <button
                                  key={id}
                                  role="tab"
                                  aria-selected={active}
                                  onClick={() => setEventBucket(id)}
                                  className={`evx-tab ${active ? "is-active" : ""}`}
                                >
                                  {label}
                                  <span className="tnum evx-tab-count">
                                    {n > 0 ? n : ""}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
              {booting ? (
                <SelectSkeleton className="max-w-xs" />
              ) : (
                events.length > 0 && (
                  <section className="events-strip">
                    {visibleEvents.length === 0 ? (
                      <p className="mt-4 text-pretty text-sm text-zinc-500">
                        Ningún evento coincide con la búsqueda.
                      </p>
                    ) : compactView ? (
                      /* VISTA COMPACTA: una línea por evento. Con 20+ noches la
                    grilla de tarjetas exige scroll infinito; la tabla responde
                    "cuál es la próxima y cómo va" de un vistazo. */
                      <ul className="evx-list">
                        {sortEventsForStrip(visibleEvents).map((ev) => {
                          const stat =
                            ticketCounts[String(ev.id)] ?? ticketCounts[ev.id];
                          const pill = openingPill(ev.starts_at);
                          const live = ev.status === "live";
                          return (
                            <li key={ev.id} className="evx-row">
                              <Link
                                to={`/admin?event=${ev.id}`}
                                onClick={() => haptics.tick()}
                                className="absolute inset-0"
                                aria-label={`Abrir ${ev.name}`}
                              />
                              <span className="evx-dot-wrap">
                                <span
                                  className="evx-dot"
                                  aria-hidden="true"
                                  style={{
                                    background:
                                      ev.status === "live"
                                        ? "#34d399"
                                        : ev.status === "published"
                                          ? "#f5e6c8"
                                          : ev.status === "draft"
                                            ? "#71717a"
                                            : ev.status === "cancelled"
                                              ? "#f87171"
                                              : "#a1a1aa",
                                  }}
                                />
                              </span>
                              <span className="evx-row-name truncate">
                                {ev.name}
                              </span>
                              {pill && (
                                <span className="evx-row-when">
                                  {pill.main}
                                </span>
                              )}
                              <span className="evx-row-nums tnum">
                                {stat
                                  ? `${money(stat.revenue_cents)} · ${stat.redeemed}/${stat.active}`
                                  : "…"}
                              </span>
                              <span
                                className={`evx-row-state ${live ? "is-live" : ""}`}
                              >
                                {(EV_CHIP[ev.status] ?? EV_CHIP.draft).label}
                              </span>
                              {/* Acciones de la fila: con 20+ noches la lista
                                compacta es la vista de trabajo, no un resumen
                                de solo lectura. Eliminar vive aquí para no
                                tener que abrir el backstage de cada evento. */}
                              {canDeleteEvent(ev) && (
                                <span className="evx-row-actions">
                                  <button
                                    onClick={() => deleteEvent(ev)}
                                    disabled={deletingId !== null}
                                    aria-label={`Eliminar ${ev.name}`}
                                    data-tip="Eliminar evento definitivamente"
                                    className="btn-mini btn-icon"
                                    data-variant="danger"
                                  >
                                    {deletingId === ev.id ? (
                                      <svg
                                        className="btn-spinner"
                                        viewBox="0 0 24 24"
                                        aria-hidden="true"
                                      >
                                        <circle cx="12" cy="12" r="9" />
                                      </svg>
                                    ) : (
                                      <Icon
                                        name="trash"
                                        className="h-3.5 w-3.5"
                                      />
                                    )}
                                  </button>
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className="evx-grid">
                        {sortEventsForStrip(visibleEvents).map((ev) => {
                          // Mini-reporte del evento (vendidas · dentro · recaudo) del
                          // GET agregado. undefined = aún no llegó: la tarjeta degrada
                          // a la versión sin cifras sin parpadear.
                          const stat =
                            ticketCounts[String(ev.id)] ?? ticketCounts[ev.id];
                          const sold = stat?.active ?? null;
                          const pct =
                            sold !== null && ev.capacity > 0
                              ? Math.min(
                                  100,
                                  Math.round((sold / ev.capacity) * 100),
                                )
                              : null;
                          const pill = openingPill(ev.starts_at);
                          const live = ev.status === "live";
                          const ended = ["ended", "cancelled"].includes(
                            ev.status,
                          );
                          const hasFlyer =
                            ev.flyer_url && !badFlyers[ev.flyer_url];
                          // Iniciales del evento (fallback sin flyer): primera
                          // palabra completa + inicial de la segunda, max 2.
                          const initials = (ev.name || "?")
                            .split(/\s+/)
                            .slice(0, 2)
                            .map((w) => w[0])
                            .join("")
                            .toUpperCase();
                          return (
                            <div
                              key={ev.id}
                              className={`event-card evx-card ${live ? "is-live" : ""} ${
                                ev.status === "published" ? "is-published" : ""
                              } ${ended ? "is-ended" : ""}`}
                              style={
                                !live && !ended
                                  ? undefined
                                  : {
                                      "--evx-bar": STATUS_DOT_COLOR[ev.status],
                                    }
                              }
                            >
                              {/* Link superpuesto: la TARJETA entera abre el
                            backstage y deja libres las esquinas para acciones
                            (duplicar) sin anidar botones dentro del <a>. */}
                              <Link
                                to={`/admin?event=${ev.id}`}
                                onClick={() => haptics.tick()}
                                className="absolute inset-0 rounded-xl"
                                aria-label={`Abrir ${ev.name}`}
                              />
                              {/* Perno del talon: la linea punteada que
                                  separa el cuerpo de la boleta del codigo. */}
                              <span className="evx-perf" aria-hidden="true" />
                              <div className="pointer-events-none p-4">
                                {/* Fila 1: identidad. Flyer (o iniciales) + nombre
                              y estado; la fecha en su propia línea es lo
                              operativo: "cuándo es" pesa más que el aforo. */}
                                <div className="evx-idrow">
                                  {hasFlyer ? (
                                    <img
                                      src={ev.flyer_url}
                                      alt=""
                                      onError={() =>
                                        setBadFlyers((m) => ({
                                          ...m,
                                          [ev.flyer_url]: true,
                                        }))
                                      }
                                      className="evx-thumb"
                                    />
                                  ) : (
                                    <span
                                      className={`evx-thumb evx-thumb-fallback ${
                                        ended ? "is-ended" : ""
                                      }`}
                                      aria-hidden="true"
                                    >
                                      {initials}
                                    </span>
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <p className="evx-name truncate">
                                      {ev.name}
                                    </p>
                                    {pill && (
                                      <p
                                        className={`evx-when ec-when ec-when-${pill.tone} mt-1 inline-flex`}
                                      >
                                        <Icon
                                          name="calendar"
                                          className="h-3 w-3"
                                        />
                                        {pill.main}
                                      </p>
                                    )}
                                    {/* Estado + señal de apertura en su propia
                                      fila: el estado deja de pelear con los
                                      botones por la esquina y "Abrir →" dice
                                      SIEMPRE que la tarjeta se abre (sin
                                      depender del cursor ni del hover). */}
                                    <div className="evx-meta-row">
                                      <span className="evx-state">
                                        <span
                                          className={`evx-dot ${live ? "is-live" : ""}`}
                                          aria-hidden="true"
                                          style={{
                                            background:
                                              STATUS_DOT_COLOR[ev.status],
                                          }}
                                        />
                                        {
                                          (EV_CHIP[ev.status] ?? EV_CHIP.draft)
                                            .label
                                        }
                                      </span>
                                      <span className="evx-open-label">
                                        Abrir
                                        <Icon
                                          name="arrowRight"
                                          className="h-3 w-3"
                                          aria-hidden="true"
                                        />
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {/* Fila 2: las TRES cifras que responden las tres
                              preguntas de la noche, CADA UNA ROTULADA (antes
                              "0/1 dentro" flotaba sin contexto y "$ 0" en
                              verde prometia dinero que no hay). El recaudo
                              manda en tamanio; vendidas y entraron en tinta
                              media. */}
                                {sold !== null ? (
                                  <div className="evx-stats">
                                    <div className="evx-stat">
                                      <span className="evx-stat-label">
                                        Recaudo
                                      </span>
                                      <span
                                        className={`evx-stat-value tnum ${
                                          stat.revenue_cents > 0
                                            ? "has-money"
                                            : ""
                                        }`}
                                      >
                                        {money(stat.revenue_cents)}
                                      </span>
                                    </div>
                                    <div className="evx-stat">
                                      <span className="evx-stat-label">
                                        Vendidas
                                      </span>
                                      <span className="evx-stat-value tnum">
                                        {sold}
                                        <span className="evx-stat-denom">
                                          /{ev.capacity}
                                        </span>
                                      </span>
                                    </div>
                                    <div className="evx-stat">
                                      <span className="evx-stat-label">
                                        Entraron
                                      </span>
                                      <span
                                        className={`evx-stat-value tnum ${
                                          live && stat.redeemed > 0
                                            ? "is-counting"
                                            : ""
                                        }`}
                                      >
                                        {/* En puerta el número late: el punto
                                          esmeralda latiendo junto a la cifra
                                          dice "está pasando ahora" sin animar
                                          el número (menos ruido, más pulso). */}
                                        {live && stat.redeemed > 0 && (
                                          <span
                                            className="evx-stat-dot"
                                            aria-hidden="true"
                                          />
                                        )}
                                        {stat.redeemed}
                                      </span>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="evx-stats">
                                    {[0, 1, 2].map((i) => (
                                      <div key={i} className="evx-stat">
                                        <span className="skeleton h-2.5 w-14" />
                                        <span className="skeleton mt-1 block h-4 w-16" />
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Fila 3: aforo como barra fina + % vendido.
                              La barra es proporcion, no decoracion: color solo
                              si hay alerta real (80% ambar, 100% rojo). */}
                                {pct !== null && (
                                  <div className="evx-meterrow">
                                    <div
                                      className="evx-meter"
                                      aria-hidden="true"
                                    >
                                      <div
                                        className={`evx-meter-fill ${
                                          pct >= 100
                                            ? "is-full"
                                            : pct >= 80
                                              ? "is-warn"
                                              : ""
                                        }`}
                                        style={{ width: `${pct}%` }}
                                      />
                                    </div>
                                    {/* La proporción NOMBRADA: un "1%" suelto
                                      obliga a adivinar (¿1% de qué?). */}
                                    <span
                                      className="evx-pct tnum"
                                      data-tip="Porcentaje vendido del aforo"
                                    >
                                      {pct}%
                                    </span>
                                  </div>
                                )}
                              </div>
                              {/* Acciones de esquina al hover/focus (desktop):
                            la tarjeta es panel de control, no solo enlace.
                            Publicar/Abrir puertas desbloquean dinero y puerta;
                            duplicar apura la recurrencia semanal. */}
                              <div className="evx-actions pointer-events-auto">
                                {(ev.status === "draft" ||
                                  ev.status === "published") && (
                                  <button
                                    onClick={() =>
                                      quickTransition(
                                        ev,
                                        ev.status === "draft"
                                          ? "publish"
                                          : "live",
                                      )
                                    }
                                    disabled={busyAction !== ""}
                                    className="btn-mini"
                                    data-variant="success"
                                    data-tip={
                                      ev.status === "draft"
                                        ? "Publicar evento (pasa a la venta)"
                                        : "Abrir puertas (la puerta empieza a escanear)"
                                    }
                                  >
                                    {busyAction === `publish-${ev.id}` ||
                                    busyAction === `live-${ev.id}` ? (
                                      <svg
                                        className="btn-spinner"
                                        viewBox="0 0 24 24"
                                        aria-hidden="true"
                                      >
                                        <circle cx="12" cy="12" r="9" />
                                      </svg>
                                    ) : (
                                      <Icon name="bolt" className="h-3.5 w-3.5" />
                                    )}
                                    {ev.status === "draft"
                                      ? "Publicar"
                                      : "Abrir puertas"}
                                  </button>
                                )}
                                {/* Duplicar está disponible en TODOS los
                                    estados: de una noche en curso o pasada
                                    nace el borrador de la siguiente. */}
                                <button
                                  onClick={() => duplicateEvent(ev)}
                                  disabled={dupingId !== null}
                                  aria-label={`Duplicar ${ev.name}`}
                                  data-tip="Duplicar evento (borrador con sus tipos y cupos)"
                                  className="btn-mini btn-icon"
                                >
                                  {dupingId === ev.id ? (
                                    <svg
                                      className="btn-spinner"
                                      viewBox="0 0 24 24"
                                      aria-hidden="true"
                                    >
                                      <circle cx="12" cy="12" r="9" />
                                    </svg>
                                  ) : (
                                    <Icon name="copy" className="h-3.5 w-3.5" />
                                  )}
                                </button>
                                {/* Eliminar: para limpiar el calendario de 20
                                    noches sin entrar al backstage de cada
                                    evento. Solo donde el backend lo permite. */}
                                {canDeleteEvent(ev) && (
                                  <button
                                    onClick={() => deleteEvent(ev)}
                                    disabled={deletingId !== null}
                                    aria-label={`Eliminar ${ev.name}`}
                                    data-tip="Eliminar evento definitivamente"
                                    className="btn-mini btn-icon"
                                    data-variant="danger"
                                  >
                                    {deletingId === ev.id ? (
                                      <svg
                                        className="btn-spinner"
                                        viewBox="0 0 24 24"
                                        aria-hidden="true"
                                      >
                                        <circle cx="12" cy="12" r="9" />
                                      </svg>
                                    ) : (
                                      <Icon
                                        name="trash"
                                        className="h-3.5 w-3.5"
                                      />
                                    )}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                )
              )}
            </VenueHeader>

            {/* Acción primaria al alcance del pulgar (solo móvil, modo lista):
              con una lista larga, "Nuevo evento" en el header queda aizar
              tras hacer scroll. La FAB flotante lo mantiene a un toque,
              encima de la barra de pestañas. */}
            {!selectedEventData && section === "resumen" && !createOpen && (
              <button
                onClick={() => {
                  haptics.tick();
                  setCreateOpen(true);
                }}
                aria-label="Nuevo evento"
                data-tip="Nuevo evento"
                className="fixed right-4 z-20 grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-white shadow-lg shadow-brand-900/40 transition active:scale-95 md:hidden"
                style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}
              >
                <Icon name="plus" className="h-6 w-6" />
              </button>
            )}

            {/* Probador de QR: leer sin canjear (solo lectura). */}
            {qrTesterOpen && (
              <QrTesterModal onClose={() => setQrTesterOpen(false)} />
            )}

            {/* Crear evento: modal (no un formulario de 10 campos en la página). */}
            {createOpen && (
              <EventCreateModal
                venueId={venueId}
                onClose={() => setCreateOpen(false)}
                onCreated={(ev) => {
                  setCreateOpen(false);
                  // El evento recién creado ABRE su backstage: nace aparte y
                  // el admin aterriza directo en la pestaña de montaje.
                  loadEvents().then(() => flyToEvent(ev.id, "entradas"));
                }}
              />
            )}
          </>
        )}
        {/* Enlace viejo o evento borrado: pantalla honesta, no un limbo */}
        {selectedEvent && !selectedEventData && (
          <EventNotFound onBack={() => setSearchParams({})} />
        )}        {selectedEvent && selectedEventData && (
          <>
            {/* Backstage del evento: identidad, pulso y ciclo de vida */}
            <EventWorkbench
              ev={selectedEventData}
              report={report}
              tab={section}
              onTab={setSection}
              actions={actions}
              onAction={runAction}
              busyAction={busyAction}
              isLive={isLive}
              lastUpdated={lastUpdated}
              onEdit={startEditEvent}
              editable={editable}
              onDelete={deleteSelectedEvent}
              onExit={() => setSearchParams({})}
              preflight={preflight}
            />

            {/* Edición del evento (draft/published) */}
            {editingEvent && editable && (
              <form onSubmit={saveEventEdit} className="card p-5">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="display text-base">Editar evento</h3>
                  <button
                    type="button"
                    onClick={() => setEditingEvent(null)}
                    className="text-xs font-semibold text-zinc-400 transition hover:text-zinc-200"
                  >
                    Cerrar
                  </button>
                </div>
                <p className="mb-4 text-xs text-zinc-500">
                  El aforo no puede bajar de las boletas ya emitidas ni la
                  apertura moverse al pasado.
                </p>

                <div className="grid gap-3.5 sm:grid-cols-2">
                  <label className="sm:col-span-full">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Nombre *
                    </span>
                    <input
                      value={editingEvent.name}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          name: e.target.value,
                        })
                      }
                      className="field"
                      maxLength={200}
                      required
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Apertura *
                    </span>
                    <input
                      type="datetime-local"
                      value={editingEvent.starts_at}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          starts_at: e.target.value,
                        })
                      }
                      className="field"
                      required
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Cierre
                    </span>
                    <input
                      type="datetime-local"
                      value={editingEvent.ends_at}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          ends_at: e.target.value,
                        })
                      }
                      className="field"
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      QR se activa (min antes)
                    </span>
                    <input
                      type="number"
                      value={editingEvent.qr_unlock_minutes}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          qr_unlock_minutes: e.target.value,
                        })
                      }
                      className="field"
                      min="0"
                      required
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Aforo *
                    </span>
                    <input
                      type="number"
                      value={editingEvent.capacity}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          capacity: e.target.value,
                        })
                      }
                      className="field"
                      min="1"
                      required
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Flyer (URL)
                    </span>
                    <input
                      type="url"
                      value={editingEvent.flyer_url}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          flyer_url: e.target.value,
                        })
                      }
                      className="field"
                      placeholder="https://…/flyer.jpg"
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Lugar
                    </span>
                    <input
                      value={editingEvent.location}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          location: e.target.value,
                        })
                      }
                      className="field"
                      placeholder="Calle 45 #12-30"
                      maxLength={200}
                    />
                  </label>

                  <label className="sm:col-span-full">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Descripción
                    </span>
                    <textarea
                      value={editingEvent.description}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          description: e.target.value,
                        })
                      }
                      className="field"
                      rows={2}
                      maxLength={2000}
                    />
                  </label>
                </div>

                {editError && (
                  <p className="mt-3 text-xs text-red-400">{editError}</p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button className="btn-primary" disabled={savingEdit}>
                    {savingEdit ? "Guardando" : "Guardar cambios"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingEvent(null)}
                    className="btn-ghost text-sm font-bold"
                  >
                    Cancelar
                  </button>
                  {editingEvent.flyer_url &&
                    !badFlyers[editingEvent.flyer_url] && (
                      <img
                        src={editingEvent.flyer_url}
                        alt="Previsualización del flyer"
                        onError={() =>
                          setBadFlyers((m) => ({
                            ...m,
                            [editingEvent.flyer_url]: true,
                          }))
                        }
                        className="h-12 w-12 rounded-lg object-cover ring-1 ring-zinc-700"
                      />
                    )}
                </div>
              </form>
            )}

            {/* ====== Pestañas dentro del backstage ====== */}
            {section === "resumen" && (
              <div className="grid gap-5 lg:grid-cols-2">
                {report ? (
                  <ReportWidget report={report} />
                ) : (
                  <StatSkeletonRow />
                )}
                {closing && (
                  <div className="card p-4 lg:col-span-2">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="eyebrow">Cierre de noche</p>
                        <p className="mt-0.5 text-sm text-zinc-400">
                          Caja + puerta + equipo de ESTA noche en un CSV para el
                          contador. Se descarga con los datos de ahora.
                        </p>
                      </div>
                      <button
                        onClick={closeNight}
                        className="btn-primary shrink-0"
                      >
                        <Icon name="download" className="h-4 w-4" />
                        Cerrar noche
                      </button>
                    </div>
                  </div>
                )}
                {/* Tips operativos: el qué-hacer-now del evento, sin duplicar
                  el ciclo de vida (que vive siempre visible en el header). */}
                <div className="card p-4">
                  <p className="eyebrow">Puerta</p>
                  <p className="display mb-2 mt-0.5 text-base">
                    Cómo va la puerta
                  </p>
                  <ul className="space-y-2 text-sm text-zinc-300">
                    <li className="flex items-center justify-between gap-2">
                      <span>Boletas pendientes de entrar</span>
                      <span className="tnum font-bold text-amber-300">
                        {(report?.issued ?? 0) - (report?.redeemed ?? 0)}
                      </span>
                    </li>
                    <li className="flex items-center justify-between gap-2">
                      <span>Ya ingresaron</span>
                      <span className="tnum font-bold text-emerald-300">
                        {report?.redeemed ?? 0}
                      </span>
                    </li>
                    <li className="flex items-center justify-between gap-2">
                      <span>Aforo disponible</span>
                      <span className="tnum font-bold text-zinc-100">
                        {Math.max(
                          0,
                          (selectedEventData?.capacity ?? 0) -
                            (report?.issued ?? 0),
                        )}
                      </span>
                    </li>
                  </ul>
                  {isLive && (
                    <p className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 ring-1 ring-emerald-500/30">
                      🚪 Puertas abiertas: los escaneos actualizan estos números
                      en vivo.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Pestañas separadas: cada pantalla una tarea, todo con control
                total. "Entradas" monta el producto; "Cupos" delega la venta;
                "Boletas" audita lo vendido y entrega los QR. */}
            {section === "entradas" && (
              <TypeManager
                venueId={venueId}
                eventId={selectedEvent}
                types={types}
                onChange={setTypes}
              />
            )}

            {section === "cupos" && (
              <AllocationManager
                venueId={venueId}
                eventId={selectedEvent}
                allocations={allocations}
                types={types}
                users={users}
                onChange={setAllocations}
              />
            )}

            {(section === "boletas" ||
              section === "entradas" ||
              section === "cupos") && (
              <TicketList
                venueId={venueId}
                eventId={selectedEvent}
                onChanged={refreshEventData}
                onError={setError}
              />
            )}

            {/* "Equipo" DENTRO de la noche (mig 025): el roster de esta noche y
                los links de puerta. Es lo unico de "Del negocio" que depende
                del evento — el resto (Equipo del bar, Liquidaciones) sigue en
                la portada porque no cambia con la noche abierta. */}
            {section === "noche" && selectedEventData && (
              <EventTeamPanel
                venueId={venueId}
                event={selectedEventData}
                preflight={preflight}
              />
            )}
          </>
        )}
        {/* Divisor de lazo (scrapbook): cierra la portada de la noche antes
            de la zona "del negocio", como los separadores del cartel. */}
        {!selectedEventData && events?.length > 0 && (
          <RibbonDivider className="my-1" />
        )}
        {/* ====== Del negocio: viven FUERA del evento ====== */}
        {/* Siempre visibles en modo lista: Reportes, Equipo, Liquidaciones e
          Invitaciones no cambian con el evento elegido — son del negocio, no
          de la noche. Dentro de un evento abierto NO existen: ahí solo hay
          pestañas de ese evento. */}
        {!selectedEventData && (
          <BusinessDock
            venueId={venueId}
            section={section}
            onNavigate={(id) => setSearchParams({ tab: id })}
          />
        )}
        {/* Secciones de venue: se renderizan cuando su pestaña está activa y
          NO hay evento abierto (en modo evento la pestaña activa es del
          evento; estas secciones son alcanzables desde la lista). */}
        {!selectedEventData && section === "cobros" && (
          <PaymentsPanel venueId={venueId} events={events ?? []} />
        )}
        {!selectedEventData && section === "negocio" && (
          <BusinessOverview
            venueId={venueId}
            onOpenEvent={(id) => flyToEvent(id, "resumen")}
          />
        )}
        {!selectedEventData && section === "equipo" && (
          <TeamManager
            venueId={venueId}
            users={users}
            onChanged={reloadUsers}
          />
        )}
        {!selectedEventData && section === "liquidaciones" && (
          <PayoutsManager venueId={venueId} users={users} />
        )}
        {!selectedEventData && section === "invitaciones" && (
          <InvitationsManager venueId={venueId} />
        )}
      </div>
    </PullToRefresh>
  );
}
