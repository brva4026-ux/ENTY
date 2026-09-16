import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import ReportWidget from "../components/ReportWidget";
import Icon from "../components/Icon";
import { EventStatusBadge, QuotaMeter } from "../components/Brand";
import { eventDate } from "../lib/format";

function firstVenueId(user) {
  const ids = Object.keys(user?.roles || {}).map(Number);
  return ids[0] ?? null;
}

const NEXT_ACTIONS = {
  draft: [{ action: "publish", label: "Publicar evento" }],
  published: [{ action: "live", label: "Abrir puertas" }],
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
  const venueId = firstVenueId(user);

  const [events, setEvents] = useState([]);
  const [types, setTypes] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [report, setReport] = useState(null);
  const [users, setUsers] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [form, setForm] = useState({ name: "", capacity: 100 });

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
  useEffect(() => {
    if (!venueId) return;
    apiFetch(`/venues/${venueId}/users`)
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [venueId]);

  useEffect(() => {
    if (!selectedEvent) return;
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/types`)
      .then(setTypes)
      .catch((e) => setError(e.message));
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/allocations`)
      .then(setAllocations)
      .catch((e) => setError(e.message));
    // El admin ve la caja: usa `/summary` (incluye ingresos e integridad de
    // puerta). El promotor sigue con `/report`, que no expone dinero.
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/summary`)
      .then(setReport)
      .catch((e) => setError(e.message));
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/tickets`)
      .then(setTickets)
      .catch(() => setTickets([]));
  }, [selectedEvent, venueId]);

  // En puerta el admin deja esta pantalla abierta: refrescar sola cada 20s
  // evita que decida con cifras viejas.
  useEffect(() => {
    if (!selectedEvent) return;
    const id = setInterval(() => {
      refreshEventData();
    }, 20000);
    return () => clearInterval(id);
  }, [selectedEvent, venueId]);

  async function refreshEventData() {
    if (!selectedEvent) return;
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/summary`).then(setReport).catch(() => {});
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/tickets`).then(setTickets).catch(() => {});
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/allocations`).then(setAllocations).catch(() => {});
  }

  async function runAction(action, label) {
    if (!selectedEvent) return;
    const confirmMsg =
      action === "cancel"
        ? "¿Cancelar el evento? No se podrá revertir."
        : action === "end"
          ? "¿Finalizar el evento? La puerta dejará de aceptar escaneos."
          : null;
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusyAction(action);
    setError("");
    try {
      const updated = await apiFetch(`/venues/${venueId}/events/${selectedEvent}/${action}`, {
        method: "POST",
      });
      setEvents((evs) => evs.map((e) => (e.id === updated.id ? updated : e)));
      await refreshEventData();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  async function createEvent(e) {
    e.preventDefault();
    try {
      const ev = await apiFetch(`/venues/${venueId}/events`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          capacity: Number(form.capacity),
          starts_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        }),
      });
      setForm({ name: "", capacity: 100 });
      setSelectedEvent(ev.id);
      await loadEvents();
    } catch (err) {
      setError(err.message);
    }
  }

  const selectedEventData = events.find((ev) => ev.id === selectedEvent);
  const actions = selectedEventData ? NEXT_ACTIONS[selectedEventData.status] ?? [] : [];

  if (!venueId) {
    return (
      <div className="card-lit card p-6 text-center text-slate-400">
        No tienes venues asociadas. Habla con un super admin.
      </div>
    );
  }

  return (
    <div className="animate-rise space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="eyebrow">Administración</p>
          <h2 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-white">
            Panel de administración
          </h2>
        </div>
        {selectedEventData && <EventStatusBadge status={selectedEventData.status} />}
      </div>

      <TeamManager venueId={venueId} users={users} onCreated={(u) => setUsers((prev) => {
        const exists = prev.some((x) => x.id === u.id);
        return exists ? prev.map((x) => (x.id === u.id ? u : x)) : [...prev, u];
      })} />

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Crear evento */}
      <form onSubmit={createEvent} className="card-lit card p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-200">
          <Icon name="plus" className="h-4 w-4 text-brand-400" />
          Crear evento
        </h3>
        <div className="flex flex-wrap gap-2">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Nombre del evento"
            className="field !w-auto min-w-44 flex-1"
            required
          />
          <input
            type="number"
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            placeholder="Aforo"
            className="field !w-28"
            min="1"
            required
          />
          <button className="btn-primary">Crear</button>
        </div>
      </form>

      {/* Selector de evento */}
      {events.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow">Evento</span>
          {events.map((ev) => (
            <button
              key={ev.id}
              onClick={() => setSelectedEvent(ev.id)}
              className={`group rounded-xl border px-3.5 py-2 text-left transition ${
                selectedEvent === ev.id
                  ? "border-brand-500/50 bg-gradient-to-b from-brand-600/25 to-brand-600/5 shadow-lg shadow-brand-600/10"
                  : "border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-800/60"
              }`}
            >
              <span
                className={`block text-sm font-semibold ${
                  selectedEvent === ev.id ? "text-white" : "text-slate-300"
                }`}
              >
                {ev.name}
              </span>
              {/* La fecha evita confundir dos eventos con el mismo nombre. */}
              <span className="tnum mt-0.5 block font-mono text-[10px] text-slate-500">
                {eventDate(ev.starts_at)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="card-lit card p-10 text-center">
          <span className="tile mx-auto mb-3 grid h-12 w-12">
            <Icon name="flag" className="h-6 w-6" />
          </span>
          <p className="font-semibold text-slate-300">Aún no hay eventos.</p>
          <p className="mt-1 text-sm text-slate-500">Crea el primero arriba para empezar.</p>
        </div>
      )}

      {selectedEvent && (
        <>
          <ReportWidget report={report} live={selectedEventData?.status === "live"} />

          {/* Ciclo de vida del evento */}
          {actions.length > 0 && (
            <div className="card-lit card flex flex-wrap items-center gap-3 p-4">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Ciclo de vida
              </span>
              {actions.map(({ action, label }) => (
                <button
                  key={action}
                  onClick={() => runAction(action, label)}
                  disabled={busyAction === action}
                  className={
                    action === "publish"
                      ? "btn-primary !py-2 text-sm"
                      : "btn-ghost text-sm font-bold"
                  }
                >
                  {busyAction === action ? "Procesando…" : label}
                </button>
              ))}
            </div>
          )}

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

          <TicketList
            venueId={venueId}
            eventId={selectedEvent}
            tickets={tickets}
            onChanged={refreshEventData}
            onError={setError}
          />
        </>
      )}
    </div>
  );
}

function TypeManager({ venueId, eventId, types, onChange }) {
  const [name, setName] = useState("General");
  const [price, setPrice] = useState("30000");
  const [qty, setQty] = useState("50");
  const [isCourtesy, setIsCourtesy] = useState(false);
  const [err, setErr] = useState("");

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
    } catch (e2) {
      setErr(e2.message);
    }
  }

  return (
    <div className="card-lit card p-5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-200">
        <Icon name="ticket" className="h-4 w-4 text-brand-400" />
        Tipos de boleta
      </h3>
      <ul className="mb-4 space-y-2">
        {(types || []).map((t) => (
          <li
            key={t.id}
            className="flex items-center justify-between rounded-lg bg-slate-800/40 px-3 py-2 text-sm"
          >
            <span className="font-semibold text-slate-200">
              {t.name}
              {t.is_courtesy && (
                <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300 ring-1 ring-emerald-500/30">
                  cortesía
                </span>
              )}
            </span>
            <span className="tnum text-slate-400">
              {t.price_cents > 0 ? `$${(t.price_cents / 100).toLocaleString("es-CO")}` : "gratis"}{" "}
              · cupo {t.quantity}
            </span>
          </li>
        ))}
        {(types || []).length === 0 && (
          <li className="rounded-lg bg-slate-800/40 px-3 py-2 text-sm text-slate-500">
            Sin tipos aún — agrega el primero abajo.
          </li>
        )}
      </ul>
      <form onSubmit={createType} className="grid grid-cols-2 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className="field col-span-2" placeholder="Nombre" />
        <input value={price} onChange={(e) => setPrice(e.target.value)} className="field" placeholder="Precio (centavos)" />
        <input value={qty} onChange={(e) => setQty(e.target.value)} className="field" placeholder="Cantidad" />
        <label className="col-span-2 flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={isCourtesy} onChange={(e) => setIsCourtesy(e.target.checked)} className="accent-brand-500" />
          Cortesía (precio 0)
        </label>
        {err && <p className="col-span-2 text-xs text-red-400">{err}</p>}
        <button className="btn-ghost col-span-2 font-bold">Agregar tipo</button>
      </form>
    </div>
  );
}

function AllocationManager({ venueId, eventId, allocations, types, users, onChange }) {
  const [promoterId, setPromoterId] = useState("");
  const [typeId, setTypeId] = useState("");
  const [capacity, setCapacity] = useState("5");
  const [err, setErr] = useState("");

  const promoters = (users || []).filter((u) =>
    u.roles?.includes("promotor") || u.roles?.includes("admin")
  );

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

  return (
    <div className="card-lit card p-5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-200">
        <Icon name="users" className="h-4 w-4 text-brand-400" />
        Cupos de promotor
      </h3>
      <ul className="mb-4 space-y-2">
        {(allocations || []).map((a) => {
          const t = (types || []).find((x) => x.id === a.ticket_type_id);
          const u = (users || []).find((x) => x.id === a.promoter_id);
          return (
            <li key={a.id} className="rounded-lg bg-slate-800/40 px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <span className="font-semibold text-slate-200">
                  {u ? u.full_name : `Promotor #${a.promoter_id}`}
                </span>
                <span className="tnum text-xs text-slate-400">
                  {t ? t.name : `tipo ${a.ticket_type_id}`}
                </span>
              </div>
              <QuotaMeter used={a.issued ?? 0} total={a.capacity} label="Usados" compact />
            </li>
          );
        })}
        {(allocations || []).length === 0 && (
          <li className="rounded-lg bg-slate-800/40 px-3 py-2 text-sm text-slate-500">
            Sin cupos asignados todavía.
          </li>
        )}
      </ul>
      <form onSubmit={createAllocation} className="grid grid-cols-2 gap-2">
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
        <div className="col-span-2 flex gap-2">
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
        {err && <p className="col-span-2 text-xs text-red-400">{err}</p>}
        {promoters.length === 0 && (
          <p className="col-span-2 text-xs text-amber-400">
            No hay usuarios en esta venue todavía — créalos con POST /seed o agregándolos a la DB.
          </p>
        )}
      </form>
    </div>
  );
}

function TeamManager({ venueId, users, onCreated }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ full_name: "", email: "", password: "", role: "promotor" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function createUser(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const u = await apiFetch(`/venues/${venueId}/users`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      onCreated(u);
      setForm({ full_name: "", email: "", password: "", role: "promotor" });
      setOpen(false);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card-lit card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-200">
          <Icon name="users" className="h-4 w-4 text-brand-400" />
          Equipo de la venue
        </h3>
        <button onClick={() => setOpen((v) => !v)} className="btn-ghost text-xs font-bold">
          {open ? "Cerrar" : "+ Agregar"}
        </button>
      </div>
      <ul className="mb-4 space-y-2">
        {(users || []).map((u) => (
          <li
            key={u.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-800/40 px-3 py-2 text-sm"
          >
            <span className="font-semibold text-slate-200">{u.full_name}</span>
            <span className="flex items-center gap-1.5">
              {(u.roles || []).map((r) => (
                <span
                  key={r}
                  className="rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-brand-300 ring-1 ring-brand-500/30"
                >
                  {r}
                </span>
              ))}
            </span>
          </li>
        ))}
        {(users || []).length === 0 && (
          <li className="rounded-lg bg-slate-800/40 px-3 py-2 text-sm text-slate-500">
            Sin usuarios todavía — agrega a tu equipo arriba.
          </li>
        )}
      </ul>
      {open && (
        <form onSubmit={createUser} className="grid grid-cols-2 gap-2">
          <input
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            className="field"
            placeholder="Nombre completo"
            required
          />
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            className="field"
          >
            <option value="promotor">Promotor</option>
            <option value="bouncer">Portero (puerta)</option>
            <option value="admin">Admin</option>
          </select>
          <input
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="field"
            type="email"
            placeholder="correo@ejemplo.com"
            required
          />
          <input
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="field"
            type="password"
            placeholder="Contraseña (mín. 8)"
            minLength={8}
            required
          />
          {err && <p className="col-span-2 text-xs text-red-400">{err}</p>}
          <button disabled={busy} className="btn-primary col-span-2">
            {busy ? "Creando…" : "Crear usuario"}
          </button>
          <p className="col-span-2 text-xs text-slate-500">
            Si el correo ya existe, solo se le agrega el rol en esta venue.
          </p>
        </form>
      )}
    </div>
  );
}

function TicketList({ venueId, eventId, tickets, onChanged, onError }) {
  const [voidingId, setVoidingId] = useState(null);
  const [reason, setReason] = useState("Error de digitación");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyProblem, setOnlyProblem] = useState(false);

  const all = tickets || [];
  // El endpoint devuelve las 200 mas recientes; el filtro es en cliente para
  // que buscar sea instantaneo mientras el admin tiene a alguien en la puerta.
  const q = query.trim().toLowerCase();
  const shown = all.filter((t) => {
    if (onlyProblem && t.status !== "voided" && t.status !== "refunded") return false;
    if (!q) return true;
    return (
      String(t.id) === q ||
      (t.customer_name || "").toLowerCase().includes(q) ||
      (t.customer_phone || "").toLowerCase().includes(q)
    );
  });

  async function voidTicket(t) {
    if (!window.confirm(`¿Anular la boleta #${t.id} de ${t.customer_name}? El cupo quedará liberado.`)) return;
    setBusy(true);
    try {
      await apiFetch(`/venues/${venueId}/events/${eventId}/tickets/${t.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      setVoidingId(null);
      await onChanged();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card-lit card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="eyebrow">Boletas</p>
          <p className="mt-1 text-sm text-slate-400">
            {shown.length === all.length
              ? `${all.length} recientes`
              : `${shown.length} de ${all.length}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOnlyProblem((v) => !v)}
            className={`chip !py-1.5 text-xs ${
              onlyProblem ? "!border-red-500/40 !bg-red-500/15 !text-red-300" : ""
            }`}
          >
            Solo anuladas
          </button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar #, nombre o teléfono"
            className="field !w-56 !py-1.5 text-xs"
          />
        </div>
      </div>

      <ul className="space-y-2">
        {shown.map((t) => {
          const st = TICKET_STATUS[t.status] ?? TICKET_STATUS.issued;
          const canVoid = t.status === "issued";
          return (
            <li
              key={t.id}
              className="rounded-lg bg-slate-800/40 px-3 py-2.5 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-200">
                    <span className="tnum font-mono text-slate-500">#{t.id}</span> · {t.customer_name}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
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
                    className="rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200"
                  >
                    Cancelar
                  </button>
                </div>
              )}
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="rounded-lg bg-slate-800/40 px-3 py-3 text-sm text-slate-500">
            {all.length === 0
              ? "Todavía no se han emitido boletas para este evento."
              : "Ninguna boleta coincide con la búsqueda."}
          </li>
        )}
      </ul>
    </div>
  );
}
