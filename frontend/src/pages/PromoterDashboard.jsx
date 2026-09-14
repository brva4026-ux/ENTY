import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import TicketPreview from "../components/TicketPreview";

function firstVenueId(user) {
  const ids = Object.keys(user?.roles || {}).map(Number);
  return ids[0] ?? null;
}

export default function PromoterDashboard() {
  const { user } = useAuth();
  const venueId = firstVenueId(user);

  const [events, setEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [types, setTypes] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [form, setForm] = useState({
    ticket_type_id: "",
    allocation_id: "",
    customer_name: "",
    customer_phone: "",
    customer_email: "",
  });
  const [lastTicket, setLastTicket] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!venueId) return;
    apiFetch(`/venues/${venueId}/events`)
      .then((data) => {
        setEvents(data);
        if (data.length) setSelectedEvent(data[0].id);
      })
      .catch((e) => setError(e.message));
  }, [venueId]);

  useEffect(() => {
    if (!selectedEvent) return;
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/types`)
      .then((d) => {
        setTypes(d);
        setForm((f) => ({ ...f, ticket_type_id: d[0]?.id ?? "" }));
      })
      .catch((e) => setError(e.message));
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/allocations`)
      .then(setAllocations)
      .catch(() => setAllocations([]));
  }, [selectedEvent, venueId]);

  const courtesyTypes = types.filter((t) => t.is_courtesy);
  const paidTypes = types.filter((t) => !t.is_courtesy);
  // cupos del promotor actual, filtrados por tipo cortesía
  const myAllocations = allocations.filter(
    (a) => a.promoter_id === user.id && courtesyTypes.some((t) => t.id === a.ticket_type_id)
  );

  function handleTypeChange(id) {
    setForm((f) => {
      const isCourtesyType = types.find((t) => t.id === Number(id))?.is_courtesy;
      const alloc = isCourtesyType && myAllocations.length ? myAllocations[0].id : null;
      return { ...f, ticket_type_id: id, allocation_id: alloc };
    });
  }

  async function emit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const ticket = await apiFetch(`/venues/${venueId}/events/${selectedEvent}/tickets`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      setLastTicket(ticket);
      setForm({ ...form, customer_name: "", customer_phone: "", customer_email: "" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const waLink = lastTicket
    ? `https://wa.me/?text=${encodeURIComponent(
        "Tu boleta esta lista. Guarda el codigo QR y presentalo en la puerta.\nCodigo: " +
          lastTicket.raw_token +
          "\nID boleta: #" +
          lastTicket.ticket_id
      )}`
    : null;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">Panel del promotor</h2>
      <p className="text-sm text-slate-400">
        Hola {user?.full_name}. Emite boletas dentro de tu cupo asignado.
      </p>

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {events.length === 0 && (
        <p className="text-sm text-slate-500">No hay eventos publicados.</p>
      )}

      {events.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Formulario */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-200">Emitir boleta</h3>

            <label className="mb-1 block text-xs text-slate-400">Evento</label>
            <select
              value={selectedEvent}
              onChange={(e) => setSelectedEvent(Number(e.target.value))}
              className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-2 text-sm text-white"
            >
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.name}</option>
              ))}
            </select>

            <form onSubmit={emit} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-slate-400">Tipo de boleta</label>
                <select
                  value={form.ticket_type_id}
                  onChange={(e) => handleTypeChange(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-2 text-sm text-white"
                  required
                >
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} {t.price_cents > 0 ? `$${(t.price_cents / 100).toLocaleString("es-CO")}` : "(cortesía)"}
                    </option>
                  ))}
                </select>
              </div>

              {myAllocations.length > 0 && (
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Cupo de promotor</label>
                  <select
                    value={form.allocation_id ?? ""}
                    onChange={(e) => setForm({ ...form, allocation_id: Number(e.target.value) })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-2 text-sm text-white"
                  >
                    {myAllocations.map((a) => {
                      const t = types.find((x) => x.id === a.ticket_type_id);
                      return (
                        <option key={a.id} value={a.id}>
                          {t?.name} — usados {a.issued ?? 0}/{a.capacity}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs text-slate-400">Nombre del asistente *</label>
                <input
                  value={form.customer_name}
                  onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Teléfono *</label>
                <input
                  value={form.customer_phone}
                  onChange={(e) => setForm({ ...form, customer_phone: e.target.value })}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Correo (opcional)</label>
                <input
                  value={form.customer_email}
                  onChange={(e) => setForm({ ...form, customer_email: e.target.value })}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-indigo-500 py-2.5 font-semibold text-white hover:bg-indigo-400 disabled:opacity-50"
              >
                {busy ? "Emitiendo…" : "Emitir boleta"}
              </button>
            </form>
          </div>

          {/* Boleta resultante + wa.me */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <h3 className="mb-3 text-sm font-semibold text-slate-200">
                {lastTicket ? "Boleta generada" : "Vista previa"}
              </h3>
              {lastTicket ? (
                <div className="space-y-4">
                  <TicketPreview
                    rawToken={lastTicket.raw_token}
                    ticketId={lastTicket.ticket_id}
                    name={form.customer_name || "—"}
                    color="#6366f1"
                  />
                  <div className="rounded-lg bg-slate-800 p-3">
                    <p className="mb-1 text-xs text-slate-400">Código (solo el promotor lo ve)</p>
                    <p className="break-all font-mono text-xs text-slate-200">{lastTicket.raw_token}</p>
                  </div>
                  {waLink && (
                    <a
                      href={waLink}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-lg bg-emerald-500 py-2.5 text-center font-semibold text-white hover:bg-emerald-400"
                    >
                      Enviar por WhatsApp
                    </a>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  Emite una boleta para ver el QR y el enlace de envío.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}