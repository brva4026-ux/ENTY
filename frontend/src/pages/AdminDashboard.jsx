import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import ReportWidget from "../components/ReportWidget";
import { EventStatusBadge, QuotaMeter } from "../components/Brand";

function firstVenueId(user) {
  const ids = Object.keys(user?.roles || {}).map(Number);
  return ids[0] ?? null;
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const venueId = firstVenueId(user);

  const [events, setEvents] = useState([]);
  const [types, setTypes] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [report, setReport] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", capacity: 100 });

  const loadEvents = useCallback(async () => {
    if (!venueId) return;
    const data = await apiFetch(`/venues/${venueId}/events`);
    setEvents(data);
    if (data.length > 0) setSelectedEvent((prev) => prev ?? data[0].id);
  }, [venueId]);

  useEffect(() => {
    loadEvents().catch((e) => setError(e.message));
  }, [loadEvents]);

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
  }, [selectedEvent, venueId]);

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

  if (!venueId) {
    return (
      <div className="card p-6 text-center text-slate-400">
        No tienes venues asociadas. Habla con un super admin.
      </div>
    );
  }

  return (
    <div className="animate-rise space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl font-black tracking-tight text-white">Panel de administración</h2>
        {selectedEventData && <EventStatusBadge status={selectedEventData.status} />}
      </div>

      {error && (
        <div className="rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Crear evento */}
      <form onSubmit={createEvent} className="card p-5">
        <h3 className="mb-3 text-sm font-bold text-slate-200">Crear evento</h3>
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
          <span className="text-sm font-medium text-slate-500">Evento:</span>
          {events.map((ev) => (
            <button
              key={ev.id}
              onClick={() => setSelectedEvent(ev.id)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                selectedEvent === ev.id
                  ? "bg-gradient-to-r from-brand-600 to-accent-500 text-white shadow-lg shadow-brand-600/25"
                  : "bg-slate-800/70 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {ev.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="card p-8 text-center">
          <p className="text-slate-400">Aún no hay eventos.</p>
          <p className="mt-1 text-sm text-slate-500">Crea el primero arriba para empezar.</p>
        </div>
      )}

      {selectedEvent && (
        <>
          <ReportWidget report={report} />

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
              onChange={setAllocations}
            />
          </div>
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
    <div className="card p-5">
      <h3 className="mb-3 text-sm font-bold text-slate-200">Tipos de boleta</h3>
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

function AllocationManager({ venueId, eventId, allocations, types, onChange }) {
  const [promoterId, setPromoterId] = useState("");
  const [typeId, setTypeId] = useState("");
  const [capacity, setCapacity] = useState("5");
  const [err, setErr] = useState("");

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
      onChange([...(allocations || []), a]);
      setErr("");
    } catch (e2) {
      setErr(e2.message);
    }
  }

  return (
    <div className="card p-5">
      <h3 className="mb-3 text-sm font-bold text-slate-200">Cupos de promotor</h3>
      <ul className="mb-4 space-y-2">
        {(allocations || []).map((a) => {
          const t = (types || []).find((x) => x.id === a.ticket_type_id);
          return (
            <li key={a.id} className="rounded-lg bg-slate-800/40 px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <span className="font-semibold text-slate-200">
                  Promotor #{a.promoter_id}
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
        <input value={promoterId} onChange={(e) => setPromoterId(e.target.value)} className="field" placeholder="ID promotor" required />
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
      </form>
    </div>
  );
}
