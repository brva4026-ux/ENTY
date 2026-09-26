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
import TeamManager from "../components/TeamManager";
import InvitationsManager from "../components/InvitationsManager";
import PayoutsManager from "../components/PayoutsManager";
import TypeManager from "../components/TypeManager";
import AllocationManager from "../components/AllocationManager";
import TicketList from "../components/TicketList";
import EventCreateModal from "../components/EventCreateModal";
import QrTesterModal from "../components/QrTesterModal";
import BusinessOverview from "../components/BusinessOverview";
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
  if (diffDays === 0)
    return { main: `Hoy ${time}`, tone: "today" };
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
  // Id del evento duplicándose ahora (spinner in situ en SU tarjeta).
  const [dupingId, setDupingId] = useState(null);

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
      if (wanted !== selectedEvent) setSelectedEvent(wanted);                  // Enlace viejo con pestaña de venue dentro de un evento
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

  /** Duplica un evento (borrador con sus tipos y cupos) y abre el backstage. */
  async function duplicateEvent(ev) {
    setDupingId(ev.id);
    try {
      const copy = await apiFetch(
        `/venues/${venueId}/events/${ev.id}/duplicate`,
        { method: "POST" },
      );
      ui.success("Evento duplicado: ajusta la fecha y publica 📋");
      await loadEvents();
      flyToEvent(copy.id, "resumen");
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

  // Contadores del dock "Del negocio": una foto por seccion para que cada
  // acceso diga QUE hay ahi antes de entrar (principio de info a la vista).
  // Fire-and-forget: si un endpoint falla, el contador queda oculto (0/undefined)
  // y el dock sigue funcionando; nunca bloquea la navegacion.
  const [bizCounts, setBizCounts] = useState({});
  useEffect(() => {
    if (!venueId) return;
    const safe = (key, url, pick) =>
      apiFetch(url)
        .then((data) =>
          setBizCounts((c) => ({ ...c, [key]: pick(data) })),
        )
        .catch(() => {});
    // Liquidaciones que NO estan cerradas: accion pendiente del admin.
    safe("payouts", `/venues/${venueId}/payouts`, (rows) =>
      (rows || []).filter((p) => p.status === "pending" || p.status === "disputed")
        .length,
    );
    // Invitaciones vigentes: sin aceptar, sin revocar y no vencidas
    // (la misma definicion de validez que usa el backend al aceptar).
    safe("invites", `/auth/venues/${venueId}/invitations`, (rows) =>
      (rows || []).filter(
        (i) => !i.accepted_at && !i.revoked_at && new Date(i.expires_at) > new Date(),
      ).length,
    );
    safe("team", `/venues/${venueId}/users?include_inactive=true`, (rows) =>
      (rows || []).filter((u) => u.is_active !== false).length,
    );
  }, [venueId]);

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
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/tickets`)
      .then(setTickets)
      .catch(() => setTickets([]));
  }, [selectedEvent, venueId]);

  // Memoizado: es dependencia de reloadAll (PTR) y de useLiveRefresh; sin
  // memo, ambas corren con una closure vieja cuando cambia el evento elegido.
  const refreshEventData = useCallback(async () => {
    if (!selectedEvent) return;
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/report`)
      .then(setReport)
      .catch(() => {});
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/tickets`)
      .then(setTickets)
      .catch(() => {});
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/allocations`)
      .then(setAllocations)
      .catch(() => {});
    // El pulso de la franja también vive: en puerta cambia con cada escaneo.
    apiFetch(`/venues/${venueId}/events/ticket-counts`)
      .then(setTicketCounts)
      .catch(() => {});
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
    setBadFlyer("");
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

  async function deleteSelectedEvent() {
    const ev = selectedEventData;
    if (!ev) return;
    const confirm = await ui.prompt(`Eliminar "${ev.name}"`, {
      message:
        "Se borran también sus tipos, cupos y boletas. Esta acción no tiene deshacer.\nEscribe el nombre del evento para confirmar:",
      placeholder: ev.name,
      danger: true,
      confirmLabel: "Eliminar definitivamente",
    });
    if (confirm === null) return;
    setError("");
    try {
      await apiFetch(`/venues/${venueId}/events/${ev.id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm }),
      });
      setSelectedEvent(null);
      setSearchParams({}); // sin ?event=…: el efecto de URL re-sienta en el primer evento restante
      await loadEvents();
      ui.success("Evento eliminado");
    } catch (err) {
      setError(err.message);
    }
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
            {/* Cabecera de la venue: identidad + la cifra del mes. Vive en
              modo lista (también bajo las pestañas del negocio); dentro de
              un evento abierto manda la cabecera del evento. */}
            <VenueHeader venueId={venueId} user={user} />
            {booting ? (
              <SelectSkeleton className="max-w-xs" />
            ) : (
              <section className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="display text-base">Todos los eventos</p>
                  <div className="flex items-center gap-2">
                    {/* Jerarquía real: solo "Nuevo evento" es primaria. Las
                      secundarias van antes, más tenues (QR/Invitar). */}
                    <button
                      onClick={() => setQrTesterOpen(true)}
                      className="btn-ghost !px-3 !py-1.5 text-[11px] font-bold text-zinc-300 hover:text-brand-300"
                      data-tip="Leer un QR y ver a quién pertenece, sin canjearlo"
                    >
                      Probar QR
                    </button>
                    <Link
                      to="?tab=invitaciones"
                      className="btn-ghost !px-3 !py-1.5 text-[11px] font-bold text-amber-300 hover:text-amber-200"
                    >
                      Invitar al equipo
                    </Link>
                    <button
                      onClick={() => setCreateOpen(true)}
                      className="btn-primary !px-3 !py-1.5 text-[11px]"
                    >
                      ＋ Nuevo evento
                    </button>
                  </div>
                </div>

                {events.length > 0 && (
                  <div className="mt-3">
                    <div className="relative">
                      <Icon
                        name="search"
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                      />
                      <input
                        value={eventQuery}
                        onChange={(e) => setEventQuery(e.target.value)}
                        placeholder="Buscar evento por nombre…"
                        aria-label="Buscar evento por nombre"
                        className="field !py-2 !pl-9 text-sm"
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {BUCKETS.map(([id, label]) => {
                        const n =
                          id === "todos"
                            ? events.length
                            : events.filter((ev) => ev.status === id).length;
                        return (
                          <button
                            key={id}
                            onClick={() => setEventBucket(id)}
                            aria-pressed={eventBucket === id}
                            className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition ${
                              eventBucket === id
                                ? "border-brand-500 bg-brand-500/15 text-brand-300"
                                : "border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                            }`}
                          >
                            {label}
                            <span className="tnum ml-1 text-zinc-500">{n}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {events.length === 0 ? (
                  <EmptyState icon="door" title="Aún no hay eventos">
                    Toca "＋ Nuevo evento": nace en borrador y te lleva directo
                    a montarlo.
                  </EmptyState>
                ) : visibleEvents.length === 0 ? (
                  <p className="mt-4 text-sm text-zinc-500">
                    Ningún evento coincide con la búsqueda.
                  </p>
                ) : (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {sortEventsForStrip(visibleEvents).map((ev) => {
                      // Mini-reporte del evento (vivas · dentro · recaudo) del
                      // GET agregado. undefined = aún no llegó: la tarjeta degrada
                      // a la versión sin cifras sin parpadear.
                      const stat =
                        ticketCounts[String(ev.id)] ?? ticketCounts[ev.id];
                      const sold = stat?.active ?? null;
                      const pct =
                        sold !== null && ev.capacity > 0
                          ? Math.round((sold / ev.capacity) * 100)
                          : null;
                      const pill = openingPill(ev.starts_at);
                      const live = ev.status === "live";
                      return (
                        <div
                          key={ev.id}
                          className={`event-card card-interactive relative block rounded-xl border ${
                            live ? "is-live " : ""
                          } border-zinc-800/80`}
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
                          <div className="pointer-events-none p-3.5">
                            <div className="flex items-start justify-between gap-2">
                              <p className="min-w-0 truncate text-sm font-bold text-white">
                                {ev.name}
                              </p>
                              <div className="flex shrink-0 items-center gap-1.5">
                                {pill && (
                                  <span
                                    className={`ec-when hidden rounded-full px-2 py-0.5 text-[10px] font-bold sm:inline ${
                                      pill.tone === "today"
                                        ? "ec-when-today"
                                        : pill.tone === "soon"
                                          ? "ec-when-soon"
                                          : ""
                                    }`}
                                  >
                                    {pill.main}
                                  </span>
                                )}
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${
                                    (EV_CHIP[ev.status] ?? EV_CHIP.draft).cls
                                  }`}
                                >
                                  {(EV_CHIP[ev.status] ?? EV_CHIP.draft).label}
                                </span>
                              </div>
                            </div>

                            {/* Las cifras de la noche a un vistazo: cada celda
                              responde una pregunta operativa sin abrir el evento. */}
                            <div className="ec-stats mt-2.5">
                              {sold !== null ? (
                                <>
                                  <div className="ec-stat">
                                    <span className="tnum text-lg font-bold leading-none text-white">
                                      <CountUpNumber value={sold} />
                                    </span>
                                    <span className="ec-stat-label">
                                      Boletas
                                    </span>
                                  </div>
                                  <div className="ec-stat">
                                    <span className="tnum text-lg font-bold leading-none text-sky-300">
                                      <CountUpNumber value={stat.redeemed} />
                                    </span>
                                    <span className="ec-stat-label">Dentro</span>
                                  </div>
                                  <div className="ec-stat">
                                    <span className="tnum text-lg font-bold leading-none text-emerald-300">
                                      {money(stat.revenue_cents)}
                                    </span>
                                    <span className="ec-stat-label">
                                      Recaudo
                                    </span>
                                  </div>
                                </>
                              ) : (
                                <span className="col-span-3 h-6 skeleton w-full max-w-40" />
                              )}
                            </div>

                            {/* Semáforo de aforo: cuánto del cupo físico ya
                            está comprometido, sin abrir el evento. */}
                            {pct !== null && (
                              <div className="mt-2.5 flex items-center gap-2">
                                <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                                  <div
                                    className={`h-full rounded-full transition-all duration-500 ${
                                      pct >= 100
                                        ? "bg-red-400"
                                        : pct >= 80
                                          ? "bg-amber-400"
                                          : live
                                            ? "bg-emerald-400"
                                            : "bg-brand-400"
                                    }`}
                                    style={{
                                      width: `${Math.min(100, pct)}%`,
                                    }}
                                  />
                                </div>
                                <span className="tnum text-[10px] font-bold text-zinc-500">
                                  {pct}% de {ev.capacity}
                                </span>
                              </div>
                            )}

                            <p className="mt-2 pr-9 text-[11px] leading-snug text-zinc-500">
                              {formatShortDate(ev.starts_at)} · aforo{" "}
                              {ev.capacity}
                            </p>
                          </div>
                          {/* Acción de esquina: duplicar (la recurrencia
                            semanal en un clic). Sobre el Link que cubre la
                            tarjeta, por eso pointer-events-auto. */}
                          <button
                            onClick={() => duplicateEvent(ev)}
                            disabled={dupingId !== null}
                            aria-label={`Duplicar ${ev.name}`}
                            data-tip="Duplicar evento (borrador con sus tipos y cupos)"
                            className="pointer-events-auto absolute bottom-2.5 right-2.5 rounded-lg bg-zinc-900/90 p-1.5 text-zinc-400 ring-1 ring-zinc-800 transition hover:text-brand-300 hover:ring-brand-500/40 disabled:opacity-50"
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
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

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
        )}
        {selectedEvent && selectedEventData && (
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
                    editingEvent.flyer_url !== badFlyer && (
                      <img
                        src={editingEvent.flyer_url}
                        alt="Previsualización del flyer"
                        onError={() => setBadFlyer(editingEvent.flyer_url)}
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
                {/* Tips operativos: el qué-hacer-now del evento, sin duplicar
                  el ciclo de vida (que vive siempre visible en el header). */}
                <div className="card p-4">
                  <p className="display mb-2 text-base">Cómo va la puerta</p>
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

            {(section === "boletas" || section === "entradas" || section === "cupos") && (
              <TicketList
                venueId={venueId}
                eventId={selectedEvent}
                onChanged={refreshEventData}
                onError={setError}
              />
            )}
          </>
        )}
        {/* ====== Del negocio: viven FUERA del evento ====== */}
        {/* Siempre visibles en modo lista: Reportes, Equipo, Liquidaciones e
          Invitaciones no cambian con el evento elegido — son del negocio, no
          de la noche. Dentro de un evento abierto NO existen: ahí solo hay
          pestañas de ese evento. */}
        {!selectedEventData && (
          <nav className="bizdock card" aria-label="Secciones del negocio">
            <div className="bizdock-head">
              <div>
                <p className="eyebrow">Gestión de la venue</p>
                <h2 className="display text-lg">Del negocio</h2>
              </div>
              <p className="hidden text-xs text-zinc-500 sm:block">
                Lo que no depende de una noche puntual: números del bar,
                equipo y pagos.
              </p>
            </div>
            <div className="bizdock-grid" role="tablist">
              {[
                ["negocio", "Reportes", "La foto del mes: ventas, puerta y equipo", "chart"],
                ["cobros", "Cobros", "Enlaces de pago y quién ya pagó", "ticket"],
                ["equipo", "Equipo", "Quién vende, quién abre la puerta", "users", bizCounts.team],
                [
                  "liquidaciones",
                  "Liquidaciones",
                  "Comisiones de promotores por periodo",
                  "money",
                  bizCounts.payouts,
                ],
                [
                  "invitaciones",
                  "Invitaciones",
                  "Suma gente a tu equipo con un enlace",
                  "door",
                  bizCounts.invites,
                ],
              ].map(([id, label, desc, icon, count]) => {
                const active = section === id;
                return (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={active}
                    aria-current={active ? "page" : undefined}
                    onClick={() => {
                      haptics.tick();
                      setSearchParams({ tab: id });
                    }}
                    className={`bizdock-item${active ? " is-active" : ""}`}
                  >
                    <span className="bizdock-icon">
                      <Icon name={icon} className="h-5 w-5" />
                    </span>
                    <span className="bizdock-text">
                      <span className="bizdock-label">{label}</span>
                      <span className="bizdock-desc">{desc}</span>
                    </span>
                    {count > 0 && (
                      <span className="bizdock-count tnum">{count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </nav>
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
