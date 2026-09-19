import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { haptics } from "../lib/haptics";
import ReportWidget from "../components/ReportWidget";
import { EventStatusBadge, LiveIndicator, QuotaMeter } from "../components/Brand";
import { PullToRefresh } from "../components/PullToRefresh";
import { InstallPrompt } from "../components/InstallPrompt";
import { ListSkeleton, SelectSkeleton, Skeleton, StatSkeletonRow } from "../components/Skeleton";
import { useUI } from "../lib/ui";
import { OnboardingChecklist } from "../components/OnboardingChecklist";
import TeamManager from "../components/TeamManager";
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
    starts_at: toLocalInput(start),
    ends_at: "",
    flyer_url: "",
    description: "",
  };
}

function formatEventDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-CO", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Fecha corta para las pestañas de evento (los chips no dan para más). */
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
  const [types, setTypes] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [report, setReport] = useState(null);
  const [users, setUsers] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
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
  // Navegación por secciones: el admin trabaja por TAREA, no con todo apilado.
  const [section, setSection] = useState("overview");
  const [creatingOpen, setCreatingOpen] = useState(false);

  // events === null significa "primera carga": se muestra skeleton en vez de
  // un vacío engañoso ("Aún no hay eventos") que no es verdad aún.
  const booting = events === null;

  const loadEvents = useCallback(async () => {
    if (!venueId) return;
    const data = await apiFetch(`/venues/${venueId}/events`);
    setEvents(data);
    if (data.length > 0) setSelectedEvent((prev) => (data.some((e) => e.id === prev) ? prev : data[0].id));
  }, [venueId]);

  useEffect(() => {
    loadEvents().catch((e) => setError(e.message));
  }, [loadEvents]);

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
      setSelectedEvent(ev.id);
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

  // Contadores por pestaña: contexto de un vistazo sin cambiar de sección.
  // - overview: ocupación del evento (activas/aforo)
  // - boletas: boletas activas emitidas
  // - equipo: personas con acceso a la venue
  const activeIssued = report?.issued ?? null;
  const capacity = selectedEventData?.capacity ?? null;
  const SECTIONS = [
    {
      id: "overview",
      label: "Vista general",
      count:
        activeIssued !== null && capacity
          ? `${activeIssued}/${capacity}`
          : null,
    },
    { id: "boletas", label: "Boletas y cupos", count: activeIssued },
    { id: "equipo", label: "Equipo", count: users.length || null },
    { id: "liquidaciones", label: "Liquidaciones" },
  ];

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
      {/* Navegación de secciones: el admin trabaja por TAREA, no con todo apilado */}
      <div className="border-b border-zinc-800 pb-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="display text-2xl text-white">Panel de administración</h2>
          <div className="flex flex-wrap items-center gap-3">
            <LiveIndicator live={isLive} lastUpdated={lastUpdated} />
            {selectedEventData && <EventStatusBadge status={selectedEventData.status} />}
          </div>
        </div>

        {/* En móvil las pestañas desbordan: scroll horizontal sin scrollbar */}
        <nav className="no-scrollbar -mx-4 mt-4 flex gap-1 overflow-x-auto px-4 pb-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3.5 py-2 text-sm font-medium transition ${
                section === s.id
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              {s.label}
              {s.count !== null && s.count !== undefined && (
                <span
                  className={`tnum rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
                    section === s.id
                      ? "bg-zinc-700 text-zinc-200"
                      : "bg-zinc-800/80 text-zinc-500"
                  }`}
                >
                  {s.count}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* ====== SECCIÓN: EQUIPO ====== */}
      {section === "equipo" && (
        <TeamManager venueId={venueId} users={users} onChanged={reloadUsers} />
      )}

      {/* ====== SECCIÓN: LIQUIDACIONES ====== */}
      {section === "liquidaciones" && (
        <PayoutsManager venueId={venueId} users={users} />
      )}

      {error && (
        <div className="rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Crear evento: panel colapsable — no roba espacio las 24 horas */}
      <div className="card">
        <button
          type="button"
          onClick={() => setCreatingOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-5 py-4 text-left"
        >
          <span>
            <span className="display block text-base text-white">Crear evento</span>
            <span className="text-xs text-zinc-500">Nace en borrador: publícalo cuando esté listo para vender.</span>
          </span>
          <span className={`btn-ghost shrink-0 !px-3 !py-1.5 text-xs font-semibold`}>
            {creatingOpen ? "Cerrar" : "+ Nuevo"}
          </span>
        </button>
        {creatingOpen && (
        <form onSubmit={createEvent} className="border-t border-zinc-800/80 p-5">
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
        )}
      </div>

      {/* Selector de evento */}
      {booting ? (
        <SelectSkeleton className="max-w-xs" />
      ) : events.length > 0 ? (
        <div className="no-scrollbar -mx-4 overflow-x-auto px-4">
          <div className="flex w-max items-center gap-2">
            <span className="text-sm font-medium text-zinc-500">Evento:</span>
          {events.map((ev) => (
            <button
              key={ev.id}
              onClick={() => setSelectedEvent(ev.id)}
              className={`chip rounded-full px-4 py-1.5 text-sm font-semibold ${
                selectedEvent === ev.id
                  ? "chip-active text-white"
                  : "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {ev.name}
              <span className="ml-2 text-[11px] font-medium opacity-75">
                {formatShortDate(ev.starts_at)}
              </span>
            </button>
          ))}
          </div>
        </div>
      ) : (
        <div className="card p-8 text-center">
          <p className="text-zinc-400">Aún no hay eventos.</p>
          <p className="mt-1 text-sm text-zinc-500">Crea el primero arriba para empezar.</p>
        </div>
      )}

      {selectedEvent && (
        <>
          {selectedEventData && (
            <div className="card flex flex-wrap items-start gap-4 p-4">
              {selectedEventData.flyer_url &&
                selectedEventData.flyer_url !== badFlyer && (
                  <img
                    src={selectedEventData.flyer_url}
                    alt=""
                    onError={() => setBadFlyer(selectedEventData.flyer_url)}
                    className="h-24 w-24 shrink-0 rounded-xl object-cover ring-1 ring-zinc-700"
                  />
                )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-white">{selectedEventData.name}</p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  {formatEventDate(selectedEventData.starts_at)}
                  {selectedEventData.ends_at
                    ? ` → ${formatEventDate(selectedEventData.ends_at)}`
                    : ""}
                  {" · "}aforo {selectedEventData.capacity}
                </p>
                {selectedEventData.description && (
                  <p className="mt-2 whitespace-pre-line text-sm text-zinc-300">
                    {selectedEventData.description}
                  </p>
                )}
              </div>
              {editable && (
                <button
                  onClick={startEditEvent}
                  className="btn-ghost shrink-0 text-xs font-bold"
                >
                  Editar
                </button>
              )}
              {["draft", "cancelled"].includes(selectedEventData.status) && (
                <button
                  onClick={deleteSelectedEvent}
                  className="btn-ghost shrink-0 text-xs font-bold text-red-400"
                >
                  Eliminar
                </button>
              )}
            </div>
          )}

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

          {(section === "overview" || section === "boletas") &&
            (report ? <ReportWidget report={report} /> : <StatSkeletonRow />)}

          {/* Ciclo de vida del evento — solo en Vista general */}
          {actions.length > 0 && (
            <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center">
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Ciclo de vida
              </span>
              {actions.map(({ action, label, danger }) => (
                <button
                  key={action}
                  onClick={() => runAction(action, label)}
                  disabled={busyAction === action}
                  className={
                    action === "publish"
                      ? "btn-primary w-full !py-2.5 text-sm sm:w-auto"
                      : danger
                        ? "btn-danger-text font-semibold"
                        : "btn-ghost text-sm font-semibold"
                  }
                >
                  {busyAction === action ? "Procesando…" : label}
                </button>
              ))}
            </div>
          )}

          {(section === "overview" || section === "boletas") && (
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
          <li className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-500">
            Sin tipos aún — agrega el primero abajo.
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
          <li className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-500">
            Sin cupos asignados todavía.
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
          <li className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-3 text-sm text-zinc-500">
            Todavía no se han emitido boletas para este evento.
          </li>
        )}
      </ul>
    </div>
  );
}
