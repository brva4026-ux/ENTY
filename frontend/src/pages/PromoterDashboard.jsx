import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import TicketPreview from "../components/TicketPreview";
import { QuotaMeter } from "../components/Brand";
import Icon from "../components/Icon";

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
        // "" no es un int válido para Pydantic: normalizar a null
        body: JSON.stringify({ ...form, allocation_id: form.allocation_id || null }),
      });
      setLastTicket({ ...ticket, customerName: form.customer_name });
      setForm({ ...form, customer_name: "", customer_phone: "", customer_email: "" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const waLink = lastTicket
    ? `https://wa.me/?text=${encodeURIComponent(
        `Tu boleta está lista 🎟️\nEvento: ${events.find((ev) => ev.id === selectedEvent)?.name ?? ""}\nNombre: ${
          lastTicket.customerName ?? ""
        }\nCódigo: ${lastTicket.raw_token}\nID boleta: #${lastTicket.ticket_id}`
      )}`
    : null;

  return (
    <div className="animate-rise space-y-6">
      {/* Cabecera: la misma jerarquia que el panel de admin (eyebrow + display)
          para que las dos pantallas se lean como el mismo producto. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Promotor</p>
          <h2 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-white">
            {user?.full_name}
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Emite boletas dentro de tu cupo asignado.
          </p>
        </div>
        {myAllocations.length > 0 && (
          <div className="flex items-center gap-2 rounded-xl border border-brand-500/25 bg-brand-600/10 px-3.5 py-2">
            <Icon name="sparkle" className="h-4 w-4 text-brand-300" />
            <span className="text-xs font-semibold text-brand-200">
              {myAllocations.reduce((a, x) => a + (x.capacity - (x.issued ?? 0)), 0)} cortesías
              disponibles
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {events.length === 0 && (
        <div className="card-lit card p-10 text-center">
          <span className="tile mx-auto mb-3 grid h-12 w-12">
            <Icon name="ticket" className="h-6 w-6" />
          </span>
          <p className="font-semibold text-slate-300">No hay eventos publicados todavía.</p>
          <p className="mt-1 text-sm text-slate-500">
            Cuando el admin publique uno, aparecerá aquí.
          </p>
        </div>
      )}

      {events.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Formulario */}
          <div className="card-lit card stagger p-5" style={{ "--i": 1 }}>
            <h3 className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-200">
              <Icon name="plus" className="h-4 w-4 text-brand-400" />
              Emitir boleta
            </h3>

            <label className="mb-1 block text-xs font-medium text-slate-400">Evento</label>
            <select
              value={selectedEvent}
              onChange={(e) => setSelectedEvent(Number(e.target.value))}
              className="field mb-4"
            >
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.name}</option>
              ))}
            </select>

            <form onSubmit={emit} className="space-y-3.5">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">Tipo de boleta</label>
                <select
                  value={form.ticket_type_id}
                  onChange={(e) => handleTypeChange(e.target.value)}
                  className="field"
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
                <div className="space-y-2">
                  {myAllocations.map((a) => (
                    <QuotaMeter
                      key={a.id}
                      used={a.issued ?? 0}
                      total={a.capacity}
                      label={`Cupo ${types.find((x) => x.id === a.ticket_type_id)?.name ?? ""}`}
                    />
                  ))}
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">Nombre del asistente *</label>
                <input
                  value={form.customer_name}
                  onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
                  className="field"
                  placeholder="Nombre y apellido"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">Teléfono *</label>
                <input
                  value={form.customer_phone}
                  onChange={(e) => setForm({ ...form, customer_phone: e.target.value })}
                  className="field"
                  placeholder="573001234567"
                  inputMode="tel"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">Correo (opcional)</label>
                <input
                  value={form.customer_email}
                  onChange={(e) => setForm({ ...form, customer_email: e.target.value })}
                  className="field"
                  type="email"
                  placeholder="asistente@correo.com"
                />
              </div>

              <button type="submit" disabled={busy} className="btn-primary w-full">
                {busy ? "Emitiendo…" : "Emitir boleta"}
              </button>
            </form>
          </div>

          {/* Boleta resultante + wa.me */}
          <div className="card-lit card stagger h-fit p-5" style={{ "--i": 2 }}>
            <h3 className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-200">
              <Icon name="ticket" className="h-4 w-4 text-brand-400" />
              {lastTicket ? "Boleta generada" : "Vista previa"}
            </h3>
            {lastTicket ? (
              <div className="animate-rise space-y-4">
                <TicketPreview
                  rawToken={lastTicket.raw_token}
                  ticketId={lastTicket.ticket_id}
                  name={lastTicket.customerName || "Asistente"}
                  eventName={events.find((ev) => ev.id === selectedEvent)?.name}
                />
                <div className="rounded-lg bg-slate-800/60 p-3 ring-1 ring-slate-700/50">
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
                    <Icon name="shield" className="h-3.5 w-3.5" />
                    Código (solo el promotor lo ve)
                  </p>
                  <p className="break-all font-mono text-xs text-slate-200">{lastTicket.raw_token}</p>
                </div>
                {waLink && (
                  <a
                    href={waLink}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 py-3 font-bold text-white shadow-lg shadow-emerald-500/25 transition hover:bg-emerald-400"
                  >
                    <Icon name="whatsapp" className="h-5 w-5" />
                    Enviar por WhatsApp
                  </a>
                )}
              </div>
            ) : (
              <div className="py-12 text-center">
                <span className="tile mx-auto mb-3 grid h-16 w-16">
                  <Icon name="qr" className="h-8 w-8" />
                </span>
                <p className="text-sm text-slate-500">
                  Emite una boleta para ver el QR y el enlace de envío.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
