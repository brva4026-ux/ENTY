import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { haptics } from "../lib/haptics";
import ReportWidget from "../components/ReportWidget";
import { LiveIndicator, QuotaMeter } from "../components/Brand";
import { PullToRefresh } from "../components/PullToRefresh";
import { InstallPrompt } from "../components/InstallPrompt";
import { ListSkeleton, SelectSkeleton, Skeleton, StatSkeletonRow } from "../components/Skeleton";
import { useUI } from "../lib/ui";
import EmptyState from "../components/EmptyState";
import { OnboardingChecklist } from "../components/OnboardingChecklist";
import EventWorkbench, { EventNotFound } from "../components/EventWorkbench";
import Icon from "../components/Icon";
import TeamManager from "../components/TeamManager";
import InvitationsManager from "../components/InvitationsManager";
import PayoutsManager from "../components/PayoutsManager";

function firstVenueId(user) {
  const ids = Object.keys(user?.roles || {}).map(Number);
  return ids[0] ?? null;
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

/** Evento nuevo por defecto: dentro de una semana a las 8 p.m. */
function defaultEventForm() {
  const start = new Date(Date.now() + 7 * 86400000);
  start.setHours(20, 0, 0, 0);
  return {
    name: "",
    capacity: 100,
    // Ventana de activación del QR del invitado (patrón DICE): 60 min
    // antes de la apertura el QR "existe". 0 = solo con la apertura.
    qr_unlock_minutes: 60,
    starts_at: toLocalInput(start),
    ends_at: "",
    flyer_url: "",
    description: "",
  };
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

/* Chip de estado para la franja de eventos (versión compacta). */
const EV_CHIP = {
  draft: "bg-zinc-800 text-zinc-400",
  published: "bg-brand-500/15 text-brand-300",
  live: "bg-emerald-500/15 text-emerald-300",
  ended: "bg-zinc-800 text-zinc-500",
  cancelled: "bg-red-500/15 text-red-300",
};

/* Peso operativo de cada estado: la franja se lee de arriba hacia abajo, así
 * que lo VIVO va primero (en puerta, luego a la venta), los borradores al
 * medio y lo MUERTO al final. Dentro de los vivos manda lo próximo (lo que
 * urge); entre los pasados, lo más reciente primero. El aterrizaje por
 * defecto usa el mismo orden: abrir /admin te deja en el evento que importa. */
const STATUS_WEIGHT = { live: 0, published: 1, draft: 2, ended: 3, cancelled: 4 };

function sortEventsForStrip(events) {
  return [...(events || [])].sort((a, b) => {
    const wa = STATUS_WEIGHT[a.status] ?? 3;
    const wb = STATUS_WEIGHT[b.status] ?? 3;
    if (wa !== wb) return wa - wb;
    const ta = new Date(a.starts_at).getTime();
    const tb = new Date(b.starts_at).getTime();
    return wa >= 3 ? tb - ta : ta - tb;
  });
}

const TICKET_STATUS = {
  issued: { label: "Activa", cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40" },
  redeemed: { label: "Redimida", cls: "bg-sky-500/15 text-sky-300 ring-sky-500/40" },
  voided: { label: "Anulada", cls: "bg-red-500/15 text-red-300 ring-red-500/40" },
  refunded: { label: "Reembolsada", cls: "bg-amber-500/15 text-amber-300 ring-amber-500/40" },
};

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
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);
  // URL de flyer que ya falló al cargar: evita pintar el ícono de imagen rota.
  const [badFlyer, setBadFlyer] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [form, setForm] = useState(defaultEventForm);
  // Edición del evento seleccionado: null = cerrado, objeto = formulario abierto.
  const [editingEvent, setEditingEvent] = useState(null);
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  // La pestaña activa es la de la URL (la mig 012 ya generaba ?tab=...);
  // whitelist para no renderizar una pestaña inventada por el usuario.
  const section = ["resumen", "boletas", "equipo", "liquidaciones", "invitaciones"].includes(urlTab)
    ? urlTab
    : "resumen";

  // events === null significa "primera carga": se muestra skeleton en vez de
  // un vacío engañoso ("Aún no hay eventos") que no es verdad aún.
  const booting = events === null;

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
      if (wanted !== selectedEvent) setSelectedEvent(wanted);
    } else if (urlEvent) {
      // Evento inexistente en la URL (borrado/enlace viejo): se limpia el
      // parámetro para que la URL diga la verdad de lo que se está viendo;
      // la siguiente pasada aterriza en el primer evento.
      setSearchParams({});
    } else if (events.length > 0) {
      // Sin evento en la URL: aterrizar en el primero SOLO si no hay selección
      // vigente (p.ej. tras "Invitar al equipo", que limpia ?event= pero no
      // debe cambiar el evento abierto con cada refresh). "Primero" es el
      // primero de la franja ordenada por prioridad operativa: con un evento
      // en puerta, abrir /admin te deja DENTRO de la puerta, no en el último
      // evento creado.
      setSelectedEvent((prev) =>
        prev !== null && events.some((e) => e.id === prev)
          ? prev
          : sortEventsForStrip(events)[0].id
      );
    } else if (selectedEvent !== null) {
      setSelectedEvent(null);
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
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/tickets`)
      .then(setTickets)
      .catch(() => setTickets([]));
  }, [selectedEvent, venueId]);

  // Memoizado: es dependencia de reloadAll (PTR) y de useLiveRefresh; sin
  // memo, ambas corren con una closure vieja cuando cambia el evento elegido.
  const refreshEventData = useCallback(async () => {
    if (!selectedEvent) return;
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/report`).then(setReport).catch(() => {});
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/tickets`).then(setTickets).catch(() => {});
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/allocations`).then(setAllocations).catch(() => {});
    // El pulso de la franja también vive: en puerta cambia con cada escaneo.
    apiFetch(`/venues/${venueId}/events/ticket-counts`).then(setTicketCounts).catch(() => {});
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
      const updated = await apiFetch(`/venues/${venueId}/events/${selectedEvent}/${action}`, {
        method: "POST",
      });
      setEvents((evs) => evs.map((e) => (e.id === updated.id ? updated : e)));
      await refreshEventData();
      ui.success(
        action === "publish"
          ? "Evento publicado: ya puede vender 🎟️"
          : action === "live"
            ? "Puertas abiertas: la puerta fue avisada 🚪"
            : action === "end"
              ? "Evento finalizado"
              : "Evento cancelado"
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
      const updated = await apiFetch(`/venues/${venueId}/events/${selectedEvent}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editingEvent.name.trim(),
          capacity,
          qr_unlock_minutes: Number(editingEvent.qr_unlock_minutes),
          starts_at: startsAt.toISOString(),
          ends_at: endsAt ? endsAt.toISOString() : null,
          description: editingEvent.description.trim() || null,
          flyer_url: editingEvent.flyer_url.trim() || null,
        }),
      });
      setEvents((evs) => evs.map((x) => (x.id === updated.id ? updated : x)));
      setEditingEvent(null);
      ui.success("Cambios guardados");
    } catch (err) {
      setEditError(err.message);
    } finally {
      setSavingEdit(false);
    }
  }

  async function createEvent(e) {
    e.preventDefault();
    setFormError("");

    const startsAt = new Date(form.starts_at);
    if (Number.isNaN(startsAt.getTime())) {
      setFormError("Elige una fecha y hora de apertura validas.");
      return;
    }
    const endsAt = form.ends_at ? new Date(form.ends_at) : null;
    if (endsAt && Number.isNaN(endsAt.getTime())) {
      setFormError("La fecha de cierre no es valida.");
      return;
    }
    if (endsAt && endsAt <= startsAt) {
      setFormError("El cierre debe ser posterior a la apertura.");
      return;
    }

    setCreating(true);
    try {
      const ev = await apiFetch(`/venues/${venueId}/events`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          capacity: Number(form.capacity),
          qr_unlock_minutes: Number(form.qr_unlock_minutes),
          // datetime-local viene SIN zona horaria: new Date(...) lo interpreta
          // como hora local del navegador y toISOString() lo lleva al instante
          // UTC correcto. Mandarlo crudo lo guardaría como si fuera UTC.
          starts_at: startsAt.toISOString(),
          ends_at: endsAt ? endsAt.toISOString() : null,
          description: form.description.trim() || null,
          flyer_url: form.flyer_url.trim() || null,
          // La zona del evento es la del admin que lo crea: así la hora que
          // escribió es la que queda impresa en la boleta del cliente.
          event_timezone:
            Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Bogota",
        }),
      });
      setForm(defaultEventForm());
      setBadFlyer("");
      // El evento recién creado ABRE su backstage: nace aparte y el admin
      // aterriza directo en la pestaña de montaje (boletas y cupos).
      flyToEvent(ev.id, "boletas");
      await loadEvents();
      ui.success("Evento creado: añade tipos y cupos 🎟️");
    } catch (err) {
      setFormError(err.message);
    } finally {
      setCreating(false);
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

  const selectedEventData = (events ?? []).find((ev) => ev.id === selectedEvent);
  const actions = selectedEventData ? NEXT_ACTIONS[selectedEventData.status] ?? [] : [];
  const editable =
    selectedEventData && ["draft", "published"].includes(selectedEventData.status);

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
      {/* Guía del admin primerizo: se autodescarta al completar los 4 pasos */}
      {events !== null && (
        <OnboardingChecklist
          hasEvent={events.length > 0}
          hasTypes={types.length > 0}
          hasAllocations={allocations.length > 0}
          isPublished={selectedEventData ? ["published", "live"].includes(selectedEventData.status) : false}
        />
      )}
      {error && (
        <div className="rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* ====== Franja "Todos los eventos": el mapa de la operación ====== */}
      {booting ? (
        <SelectSkeleton className="max-w-xs" />
      ) : (
        <section className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="display text-base">Todos los eventos</p>
            <Link
              to="?tab=invitaciones"
              className="btn-ghost !px-3 !py-1.5 text-[11px] font-bold text-amber-300 hover:text-amber-200"
            >
              Invitar al equipo
            </Link>
          </div>

          {events.length === 0 ? (
            <EmptyState icon="door" title="Aún no hay eventos">
              Crea el primero: nace en borrador y te lleva directo a montarlo.
            </EmptyState>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {sortEventsForStrip(events)
                .map((ev) => {
                  const active = ev.id === selectedEvent;
                  // Pulso del evento: boletas activas (issued+redeemed), del
                  // GET agregado. undefined = aún no llegó: chip oculto.
                  const tc = ticketCounts[String(ev.id)] ?? ticketCounts[ev.id];
                  // Roles del equipo de la venue (solo se sabe con /users
                  // cargado; la franja del evento abierto muestra los suyos).
                  const roles =
                    ev.id === selectedEvent
                      ? [...new Set(users.flatMap((u) => u.roles || []))]
                      : [];
                  return (
                    <Link
                      key={ev.id}
                      to={`/admin?event=${ev.id}`}
                      onClick={() => haptics.tick()}
                      className={`card-interactive block rounded-xl border p-3.5 transition ${
                        active
                          ? "border-brand-500/60 bg-brand-500/[0.06]"
                          : "border-zinc-800/80 hover:border-zinc-700"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 truncate text-sm font-bold text-white">
                          {ev.name}
                        </p>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                            EV_CHIP[ev.status] ?? EV_CHIP.draft
                          }`}
                        >
                          {ev.status === "live" ? "en puerta" : ev.status === "published" ? "a la venta" : ev.status}
                        </span>
                      </div>
                      <p className="tnum mt-1 flex items-center gap-2 text-xs text-zinc-400">
                        <span>
                          {formatShortDate(ev.starts_at)} · aforo {ev.capacity}
                        </span>
                        {tc !== undefined && tc !== null && (
                          <span
                            className="ml-auto inline-flex items-center gap-1 rounded-full bg-zinc-800/80 px-2 py-0.5 text-[10px] font-bold text-zinc-300"
                            title="Boletas activas de este evento"
                          >
                            <Icon name="ticket" className="h-3 w-3" />
                            {tc}
                          </span>
                        )}
                      </p>
                      <p className="mt-1.5 text-[11px] leading-snug text-zinc-500">
                        {roles.length > 0 ? (
                          roles.map((r) => (
                            <span key={r} className="mr-1.5 inline-flex items-center gap-1">
                              <span
                                className={`inline-block h-1.5 w-1.5 rounded-full ${
                                  r === "bouncer"
                                    ? "bg-emerald-400"
                                    : r === "admin"
                                      ? "bg-amber-400"
                                      : "bg-brand-400"
                                }`}
                                aria-hidden
                              />
                              {r === "bouncer" ? "Puerta" : r === "admin" ? "Admin" : "Promotor"}
                            </span>
                          ))
                        ) : (
                          <span className="text-zinc-600">sin equipo asignado</span>
                        )}
                      </p>
                    </Link>
                  );
                })}
            </div>
          )}
        </section>
      )}

      {/* Crear evento: formulario siempre visible — el admin está aquí para trabajar */}
      <div className="card p-5">
        <form onSubmit={createEvent}>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <label className="sm:col-span-full">
            <span className="mb-1 block text-xs font-medium text-zinc-400">
              Nombre del evento *
            </span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Noche Electrónica"
              className="field"
              maxLength={200}
              required
            />
          </label>

          <label>
            <span className="mb-1 block text-xs font-medium text-zinc-400">
              Apertura de puertas *
            </span>
            <input
              type="datetime-local"
              value={form.starts_at}
              onChange={(e) => setForm({ ...form, starts_at: e.target.value })}
              className="field"
              required
            />
          </label>

          <label>
            <span className="mb-1 block text-xs font-medium text-zinc-400">
              Aforo (personas) *
            </span>
            <input
              type="number"
              value={form.capacity}
              onChange={(e) => setForm({ ...form, capacity: e.target.value })}
              className="field"
              placeholder="100"
              min="1"
              required
            />
          </label>

          <label>
            <span className="mb-1 block text-xs font-medium text-zinc-400">
              El QR se activa (min antes)
            </span>
            <input
              type="number"
              value={form.qr_unlock_minutes}
              onChange={(e) => setForm({ ...form, qr_unlock_minutes: e.target.value })}
              className="field"
              placeholder="60"
              min="0"
              required
            />
            <span className="mt-1 block text-[11px] text-zinc-500">
              Anti reenvío: el invitado ve su QR solo dentro de esta ventana (60 = estándar; 0 = al abrir puertas).
            </span>
          </label>

          <label>
            <span className="mb-1 block text-xs font-medium text-zinc-400">
              Cierre (opcional)
            </span>
            <input
              type="datetime-local"
              value={form.ends_at}
              onChange={(e) => setForm({ ...form, ends_at: e.target.value })}
              className="field"
            />
          </label>

          <label>
            <span className="mb-1 block text-xs font-medium text-zinc-400">
              Flyer (URL de la imagen)
            </span>
            <input
              type="url"
              value={form.flyer_url}
              onChange={(e) => setForm({ ...form, flyer_url: e.target.value })}
              className="field"
              placeholder="https://…/flyer.jpg"
            />
          </label>

          <label className="sm:col-span-full">
            <span className="mb-1 block text-xs font-medium text-zinc-400">
              Descripción (opcional)
            </span>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="field"
              rows={2}
              maxLength={2000}
              placeholder="DJ set + open bar cortesías"
            />
          </label>
        </div>

        {formError && (
          <p className="mt-3 text-xs text-red-400">{formError}</p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-primary" disabled={creating}>
            {creating ? "Creando…" : "Crear evento"}
          </button>
          {form.flyer_url && form.flyer_url !== badFlyer && (
            <img
              src={form.flyer_url}
              alt="Previsualización del flyer"
              onError={() => setBadFlyer(form.flyer_url)}
              className="h-12 w-12 rounded-lg object-cover ring-1 ring-zinc-700"
            />
          )}
          <span className="text-xs text-zinc-500">
            La hora se guarda en tu zona ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
          </span>
        </div>
        </form>
      </div>

      {/* Enlace viejo o evento borrado: pantalla honesta, no un limbo */}
      {selectedEvent && !selectedEventData && <EventNotFound onBack={() => setSearchParams({})} />}

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
                El aforo no puede bajar de las boletas ya emitidas ni la apertura
                moverse al pasado.
              </p>

              <div className="grid gap-3.5 sm:grid-cols-2">
                <label className="sm:col-span-full">
                  <span className="mb-1 block text-xs font-medium text-zinc-400">Nombre *</span>
                  <input
                    value={editingEvent.name}
                    onChange={(e) => setEditingEvent({ ...editingEvent, name: e.target.value })}
                    className="field"
                    maxLength={200}
                    required
                  />
                </label>

                <label>
                  <span className="mb-1 block text-xs font-medium text-zinc-400">Apertura *</span>
                  <input
                    type="datetime-local"
                    value={editingEvent.starts_at}
                    onChange={(e) =>
                      setEditingEvent({ ...editingEvent, starts_at: e.target.value })
                    }
                    className="field"
                    required
                  />
                </label>

                <label>
                  <span className="mb-1 block text-xs font-medium text-zinc-400">Cierre</span>
                  <input
                    type="datetime-local"
                    value={editingEvent.ends_at}
                    onChange={(e) =>
                      setEditingEvent({ ...editingEvent, ends_at: e.target.value })
                    }
                    className="field"
                  />
                </label>

                <label>
                  <span className="mb-1 block text-xs font-medium text-zinc-400">QR se activa (min antes)</span>
                  <input
                    type="number"
                    value={editingEvent.qr_unlock_minutes}
                    onChange={(e) =>
                      setEditingEvent({ ...editingEvent, qr_unlock_minutes: e.target.value })
                    }
                    className="field"
                    min="0"
                    required
                  />
                </label>

                <label>
                  <span className="mb-1 block text-xs font-medium text-zinc-400">Aforo *</span>
                  <input
                    type="number"
                    value={editingEvent.capacity}
                    onChange={(e) =>
                      setEditingEvent({ ...editingEvent, capacity: e.target.value })
                    }
                    className="field"
                    min="1"
                    required
                  />
                </label>

                <label>
                  <span className="mb-1 block text-xs font-medium text-zinc-400">Flyer (URL)</span>
                  <input
                    type="url"
                    value={editingEvent.flyer_url}
                    onChange={(e) =>
                      setEditingEvent({ ...editingEvent, flyer_url: e.target.value })
                    }
                    className="field"
                    placeholder="https://…/flyer.jpg"
                  />
                </label>

                <label className="sm:col-span-full">
                  <span className="mb-1 block text-xs font-medium text-zinc-400">Descripción</span>
                  <textarea
                    value={editingEvent.description}
                    onChange={(e) =>
                      setEditingEvent({ ...editingEvent, description: e.target.value })
                    }
                    className="field"
                    rows={2}
                    maxLength={2000}
                  />
                </label>
              </div>

              {editError && <p className="mt-3 text-xs text-red-400">{editError}</p>}

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button className="btn-primary" disabled={savingEdit}>
                  {savingEdit ? "Guardando…" : "Guardar cambios"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingEvent(null)}
                  className="btn-ghost text-sm font-bold"
                >
                  Cancelar
                </button>
                {editingEvent.flyer_url && editingEvent.flyer_url !== badFlyer && (
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
              {report ? <ReportWidget report={report} /> : <StatSkeletonRow />}
              <div className="card p-4">
                <p className="display mb-2 text-base">Ciclo de vida</p>
                {actions.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {actions.map(({ action, label, danger }) => (
                      <button
                        key={action}
                        onClick={() => runAction(action, label)}
                        disabled={busyAction === action}
                        className={
                          action === "publish" || action === "live"
                            ? "btn-primary !py-2 text-sm"
                            : danger
                              ? "btn-danger-text text-sm font-semibold"
                              : "btn-ghost text-sm font-semibold"
                        }
                      >
                        {busyAction === action ? "Procesando…" : label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-zinc-500">
                    Este evento cerró su ciclo: no tiene acciones pendientes.
                  </p>
                )}
              </div>
            </div>
          )}

          {(section === "resumen" || section === "boletas") && (
            <div className="grid gap-5 lg:grid-cols-2">
              <TypeManager
                venueId={venueId}
                eventId={selectedEvent}
                types={types}
                onChange={setTypes}
              />
              <AllocationManager
                venueId={venueId}
                eventId={selectedEvent}
                allocations={allocations}
                types={types}
                users={users}
                onChange={setAllocations}
              />
            </div>
          )}

          {section === "boletas" && (
            <TicketList
              venueId={venueId}
              eventId={selectedEvent}
              tickets={tickets}
              onChanged={refreshEventData}
              onError={setError}
            />
          )}
        </>
      )}

      {/* ====== Tareas de la venue: viven fuera del evento ====== */}
      {/* Sin evento abierto (venue nueva, enlace directo ?tab=equipo…) estas
          pestañas necesitan su propia navegación: el workbench —con el strip
          de pestañas completo— no está montado. */}
      {!selectedEventData &&
        ["equipo", "liquidaciones", "invitaciones"].includes(section) && (
          <nav className="card flex flex-wrap items-center gap-2 p-4">
            <p className="display mr-2 text-base">Tareas de la venue</p>
            {[
              ["equipo", "Equipo"],
              ["liquidaciones", "Liquidaciones"],
              ["invitaciones", "Invitaciones"],
            ].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setSearchParams({ tab: id })}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  section === id
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        )}

      {/* Se rendericen o no con evento abierto, estas secciones dependen solo
          de la venue: sin evento (venue nueva, enlace directo ?tab=…) siguen
          siendo alcanzables — no quedan rehenes del backstage. */}
      {section === "equipo" && (
        <TeamManager venueId={venueId} users={users} onChanged={reloadUsers} />
      )}
      {section === "liquidaciones" && (
        <PayoutsManager venueId={venueId} users={users} />
      )}
      {section === "invitaciones" && (
        <InvitationsManager venueId={venueId} />
      )}
    </div>
    </PullToRefresh>
  );
}

function TypeManager({ venueId, eventId, types, onChange }) {
  const ui = useUI();
  const [name, setName] = useState("General");
  const [price, setPrice] = useState("30000");
  const [qty, setQty] = useState("50");
  const [isCourtesy, setIsCourtesy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ name: "", price: "", qty: "", isCourtesy: false });
  const [busyId, setBusyId] = useState(null);

  const typeUrl = (t) => `/venues/${venueId}/events/${eventId}/types/${t.id}`;

  function replaceType(updated) {
    onChange((types || []).map((x) => (x.id === updated.id ? updated : x)));
  }

  async function createType(e) {
    e.preventDefault();
    try {
      const t = await apiFetch(`/venues/${venueId}/events/${eventId}/types`, {
        method: "POST",
        body: JSON.stringify({
          name,
          price_cents: Number(price),
          quantity: Number(qty),
          is_courtesy: isCourtesy,
        }),
      });
      onChange([...(types || []), t]);
      setErr("");
      ui.success(`Tipo "${t.name}" agregado`);
    } catch (e2) {
      setErr(e2.message);
    }
  }

  function startEdit(t) {
    setEditingId(t.id);
    setErr("");
    setInfo("");
    setDraft({
      name: t.name,
      price: String(t.price_cents),
      qty: String(t.quantity),
      isCourtesy: t.is_courtesy,
    });
  }

  async function saveEdit(t) {
    setBusyId(t.id);
    setErr("");
    try {
      const updated = await apiFetch(typeUrl(t), {
        method: "PATCH",
        body: JSON.stringify({
          name: draft.name.trim(),
          price_cents: Number(draft.price),
          quantity: Number(draft.qty),
          is_courtesy: draft.isCourtesy,
        }),
      });
      replaceType(updated);
      setEditingId(null);
      setInfo("Tipo actualizado.");
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleTypeActive(t) {
    setBusyId(t.id);
    setErr("");
    try {
      const updated = await apiFetch(typeUrl(t), {
        method: "PATCH",
        body: JSON.stringify({ is_active: !t.is_active }),
      });
      replaceType(updated);
      setInfo(updated.is_active ? "Tipo reactivado." : "Tipo archivado.");
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  async function removeType(t) {
    const ok = await ui.confirm(`¿Eliminar el tipo "${t.name}"?`, {
      message: "Si ya tiene boletas emitidas se archivará para no perder el historial.",
      danger: true,
      confirmLabel: "Eliminar",
    });
    if (!ok) return;
    setBusyId(t.id);
    setErr("");
    try {
      const res = await apiFetch(typeUrl(t), { method: "DELETE" });
      if (res.archived) {
        replaceType({ ...t, is_active: false });
      } else {
        onChange((types || []).filter((x) => x.id !== t.id));
      }
      setInfo(res.detail);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card p-5">
      <h3 className="display mb-3 text-base">Tipos de boleta</h3>
      <ul className="mb-4 space-y-2">
        {(types || []).map((t) => (
          <li
            key={t.id}
            className={`rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2 text-sm ${
              t.is_active === false ? "opacity-60" : ""
            }`}
          >
            {editingId === t.id ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="field col-span-full"
                  placeholder="Nombre"
                />
                <input
                  value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                  className="field"
                  placeholder="Precio (centavos)"
                  inputMode="numeric"
                />
                <input
                  value={draft.qty}
                  onChange={(e) => setDraft({ ...draft, qty: e.target.value })}
                  className="field"
                  placeholder="Cantidad"
                  inputMode="numeric"
                />
                <label className="col-span-full flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={draft.isCourtesy}
                    onChange={(e) => setDraft({ ...draft, isCourtesy: e.target.checked })}
                    className="accent-brand-500"
                  />
                  Cortesía (precio 0)
                </label>
                <div className="col-span-full flex gap-2">
                  <button
                    onClick={() => saveEdit(t)}
                    disabled={busyId === t.id}
                    className="btn-primary flex-1 !py-1.5 text-xs"
                  >
                    {busyId === t.id ? "Guardando…" : "Guardar"}
                  </button>
                  <button onClick={() => setEditingId(null)} className="btn-ghost text-xs">
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-semibold text-zinc-200">
                  {t.name}
                  {t.is_courtesy && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300 ring-1 ring-emerald-500/30">
                      cortesía
                    </span>
                  )}
                  {t.is_active === false && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300 ring-1 ring-amber-500/30">
                      archivado
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <span className="tnum text-zinc-400">
                    {t.price_cents > 0
                      ? `$${(t.price_cents / 100).toLocaleString("es-CO")}`
                      : "gratis"}{" "}
                    · cupo {t.quantity}
                  </span>
                  <button
                    onClick={() => startEdit(t)}
                    className="rounded-lg px-2 py-1 text-xs font-semibold text-brand-300 transition hover:bg-brand-500/10"
                  >
                    Editar
                  </button>
                  {t.is_active === false ? (
                    <button
                      onClick={() => toggleTypeActive(t)}
                      disabled={busyId === t.id}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/10"
                    >
                      Reactivar
                    </button>
                  ) : (
                    <button
                      onClick={() => removeType(t)}
                      disabled={busyId === t.id}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-red-400 transition hover:bg-red-500/10"
                    >
                      Eliminar
                    </button>
                  )}
                </span>
              </div>
            )}
          </li>
        ))}
        {(types || []).length === 0 && (
          <li className="col-span-full list-none">
            <EmptyState icon="ticket" title="Sin tipos de boleta aún">
              Agrega el primero abajo: define precio y cantidad para empezar a vender.
            </EmptyState>
          </li>
        )}
      </ul>
      <form onSubmit={createType} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className="field col-span-full" placeholder="Nombre" />
        <input value={price} onChange={(e) => setPrice(e.target.value)} className="field" placeholder="Precio (centavos)" />
        <input value={qty} onChange={(e) => setQty(e.target.value)} className="field" placeholder="Cantidad" />
        <label className="col-span-full flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={isCourtesy} onChange={(e) => setIsCourtesy(e.target.checked)} className="accent-brand-500" />
          Cortesía (precio 0)
        </label>
        {err && <p className="col-span-full text-xs text-red-400">{err}</p>}
        {info && <p className="col-span-full text-xs text-amber-300">{info}</p>}
        <button className="btn-ghost col-span-full font-bold">Agregar tipo</button>
      </form>
    </div>
  );
}

function AllocationManager({ venueId, eventId, allocations, types, users, onChange }) {
  const ui = useUI();
  const [promoterId, setPromoterId] = useState("");
  const [typeId, setTypeId] = useState("");
  const [capacity, setCapacity] = useState("5");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [draftCapacity, setDraftCapacity] = useState("5");
  const [busyId, setBusyId] = useState(null);

  const promoters = (users || []).filter((u) =>
    u.roles?.includes("promotor") || u.roles?.includes("admin")
  );

  const allocationUrl = (a) => `/venues/${venueId}/events/${eventId}/allocations/${a.id}`;

  function replaceAllocation(updated) {
    onChange((allocations || []).map((x) => (x.id === updated.id ? updated : x)));
  }

  async function createAllocation(e) {
    e.preventDefault();
    try {
      const a = await apiFetch(`/venues/${venueId}/events/${eventId}/allocations`, {
        method: "POST",
        body: JSON.stringify({
          ticket_type_id: Number(typeId),
          promoter_id: Number(promoterId),
          capacity: Number(capacity),
        }),
      });
      onChange([...(allocations || []).filter((x) => x.id !== a.id), a]);
      setErr("");
    } catch (e2) {
      setErr(e2.message);
    }
  }

  function startEdit(a) {
    setEditingId(a.id);
    setErr("");
    setInfo("");
    setDraftCapacity(String(a.capacity));
  }

  async function saveEdit(a) {
    setBusyId(a.id);
    setErr("");
    try {
      const updated = await apiFetch(allocationUrl(a), {
        method: "PATCH",
        body: JSON.stringify({ capacity: Number(draftCapacity) }),
      });
      replaceAllocation(updated);
      setEditingId(null);
      setInfo("Cupo actualizado.");
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleAllocationActive(a) {
    setBusyId(a.id);
    setErr("");
    try {
      const updated = await apiFetch(allocationUrl(a), {
        method: "PATCH",
        body: JSON.stringify({ is_active: !a.is_active }),
      });
      replaceAllocation(updated);
      setInfo(updated.is_active ? "Cupo reactivado." : "Cupo archivado.");
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  async function removeAllocation(a) {
    const who = (users || []).find((x) => x.id === a.promoter_id);
    const ok = await ui.confirm(`¿Eliminar el cupo de ${who ? who.full_name : `#${a.promoter_id}`}?`, {
      message: "Si ya tiene boletas emitidas se archivará para no perder el historial.",
      danger: true,
      confirmLabel: "Eliminar",
    });
    if (!ok) return;
    setBusyId(a.id);
    setErr("");
    try {
      const res = await apiFetch(allocationUrl(a), { method: "DELETE" });
      if (res.archived) {
        replaceAllocation({ ...a, is_active: false });
      } else {
        onChange((allocations || []).filter((x) => x.id !== a.id));
      }
      setInfo(res.detail);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card p-5">
      <h3 className="display mb-3 text-base">Cupos de promotor</h3>
      <ul className="mb-4 space-y-2">
        {(allocations || []).map((a) => {
          const t = (types || []).find((x) => x.id === a.ticket_type_id);
          const u = (users || []).find((x) => x.id === a.promoter_id);
          return (
            <li
              key={a.id}
              className={`rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2 ${
                a.is_active === false ? "opacity-60" : ""
              }`}
            >
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 font-semibold text-zinc-200">
                  {u ? u.full_name : `Promotor #${a.promoter_id}`}
                  {a.is_active === false && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300 ring-1 ring-amber-500/30">
                      archivado
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <span className="tnum text-xs text-zinc-400">
                    {t ? t.name : `tipo ${a.ticket_type_id}`}
                  </span>
                  <button
                    onClick={() => startEdit(a)}
                    className="rounded-lg px-2 py-1 text-xs font-semibold text-brand-300 transition hover:bg-brand-500/10"
                  >
                    Editar
                  </button>
                  {a.is_active === false ? (
                    <button
                      onClick={() => toggleAllocationActive(a)}
                      disabled={busyId === a.id}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/10"
                    >
                      Reactivar
                    </button>
                  ) : (
                    <button
                      onClick={() => removeAllocation(a)}
                      disabled={busyId === a.id}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-red-400 transition hover:bg-red-500/10"
                    >
                      Eliminar
                    </button>
                  )}
                </span>
              </div>
              {editingId === a.id ? (
                <div className="flex gap-2">
                  <input
                    value={draftCapacity}
                    onChange={(e) => setDraftCapacity(e.target.value)}
                    className="field !py-1.5 text-xs"
                    placeholder="Capacidad"
                    inputMode="numeric"
                  />
                  <button
                    onClick={() => saveEdit(a)}
                    disabled={busyId === a.id}
                    className="btn-primary !py-1.5 text-xs"
                  >
                    {busyId === a.id ? "Guardando…" : "Guardar"}
                  </button>
                  <button onClick={() => setEditingId(null)} className="btn-ghost text-xs">
                    Cancelar
                  </button>
                </div>
              ) : (
                <QuotaMeter used={a.issued ?? 0} total={a.capacity} label="Usados" compact />
              )}
            </li>
          );
        })}
        {(allocations || []).length === 0 && (
          <li className="col-span-full list-none">
            <EmptyState icon="users" title="Sin cupos asignados">
              Asigna cuántas boletas puede emitir cada promotor: el anti-sobreventa vive aquí.
            </EmptyState>
          </li>
        )}
      </ul>
      <form onSubmit={createAllocation} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <select
          value={promoterId}
          onChange={(e) => setPromoterId(e.target.value)}
          className="field"
          required
        >
          <option value="">Promotor…</option>
          {promoters.map((u) => (
            <option key={u.id} value={u.id}>
              {u.full_name}
            </option>
          ))}
        </select>
        <input value={capacity} onChange={(e) => setCapacity(e.target.value)} className="field" placeholder="Capacidad" required />
        <div className="col-span-full flex gap-2">
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className="field flex-1" required>
            <option value="">Tipo…</option>
            {(types || []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button className="btn-ghost font-bold">Asignar</button>
        </div>
        {err && <p className="col-span-full text-xs text-red-400">{err}</p>}
        {info && <p className="col-span-full text-xs text-amber-300">{info}</p>}
        {promoters.length === 0 && (
          <p className="col-span-full text-xs text-amber-400">
            No hay usuarios en esta venue todavía — créalos con POST /seed o agregándolos a la DB.
          </p>
        )}
      </form>
    </div>
  );
}

function TicketList({ venueId, eventId, tickets, onChanged, onError }) {
  const ui = useUI();
  const [voidingId, setVoidingId] = useState(null);
  const [reason, setReason] = useState("Error de digitación");
  const [busy, setBusy] = useState(false);

  async function voidTicket(t) {
    const ok = await ui.confirm(`¿Anular la boleta #${t.id}?`, {
      message: `Se anula la boleta de ${t.customer_name}. El cupo quedará liberado.`,
      danger: true,
      confirmLabel: "Anular boleta",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch(`/venues/${venueId}/events/${eventId}/tickets/${t.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      setVoidingId(null);
      await onChanged();
      ui.success(`Boleta #${t.id} anulada`);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const [query, setQuery] = useState("");
  const filtered = (tickets || []).filter((t) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      String(t.id) === q.replace("#", "") ||
      t.customer_name?.toLowerCase().includes(q) ||
      t.customer_phone?.includes(q) ||
      t.type_name?.toLowerCase().includes(q) ||
      t.sold_by_name?.toLowerCase().includes(q)
    );
  });

  async function downloadCsv(kind) {
    try {
      const res = await fetch(`/api/venues/${venueId}/events/${eventId}/${kind}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("tf_token")}` },
      });
      if (!res.ok) throw new Error("No se pudo generar el archivo");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${kind.replace(".csv", "")}-evento-${eventId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      onError(e.message);
    }
  }

  return (
    <div className="card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="display text-base">Boletas emitidas</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => downloadCsv("guests.csv")} className="btn-ghost text-xs font-bold">Exportar invitados</button>
          <button onClick={() => downloadCsv("revenue.csv")} className="btn-ghost text-xs font-bold">Exportar recaudo</button>
          <button onClick={() => downloadCsv("noshow.csv")} className="btn-ghost text-xs font-bold">No-shows</button>
          <span className="tnum text-xs text-zinc-500">{(tickets || []).length} recientes</span>
        </div>
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="field mb-3"
        placeholder="Buscar por nombre, teléfono, #boleta, tipo o promotor…"
      />
      <ul className="space-y-2">
        {filtered.map((t) => {
          const st = TICKET_STATUS[t.status] ?? TICKET_STATUS.issued;
          const canVoid = t.status === "issued";
          return (
            <li
              key={t.id}
              className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2.5 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-zinc-200">
                    <span className="tnum text-zinc-500">#{t.id}</span> · {t.customer_name}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {t.type_name ?? "—"}
                    {t.from_allocation ? " · cupo promotor" : " · venta directa"}
                    {t.sold_by_name ? ` · por ${t.sold_by_name}` : ""}
                    {t.price_cents_snapshot > 0
                      ? ` · $${(t.price_cents_snapshot / 100).toLocaleString("es-CO")}`
                      : " · cortesía"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${st.cls}`}>
                    {st.label}
                  </span>
                  {canVoid && voidingId !== t.id && (
                    <button
                      onClick={() => { setVoidingId(t.id); setReason("Error de digitación"); }}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-red-400 transition hover:bg-red-500/10"
                    >
                      Anular
                    </button>
                  )}
                </div>
              </div>
              {voidingId === t.id && (
                <div className="mt-2 flex gap-2">
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="field !py-1.5 text-xs"
                    placeholder="Motivo de anulación"
                    minLength={3}
                    required
                  />
                  <button
                    onClick={() => voidTicket(t)}
                    disabled={busy || reason.trim().length < 3}
                    className="rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-red-500 disabled:opacity-50"
                  >
                    {busy ? "Anulando…" : "Confirmar"}
                  </button>
                  <button
                    onClick={() => setVoidingId(null)}
                    className="rounded-lg px-2 py-1.5 text-xs font-semibold text-zinc-400 hover:text-zinc-200"
                  >
                    Cancelar
                  </button>
                </div>
              )}
            </li>
          );
        })}
        {filtered.length === 0 && (tickets || []).length > 0 && (
          <li className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-3 text-sm text-zinc-500">
            Ninguna boleta coincide con la búsqueda.
          </li>
        )}
        {(tickets || []).length === 0 && (
          <li className="list-none">
            <EmptyState icon="ticket" title="Aún no hay boletas para este evento">
              Cuando un promotor emita la primera, aparecerá aquí con su estado en vivo.
            </EmptyState>
          </li>
        )}
      </ul>
    </div>
  );
}
