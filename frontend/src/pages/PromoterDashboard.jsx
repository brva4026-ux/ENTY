import { useCallback, useEffect, useState } from "react";
import { apiFetch, publicTicketImageUrl } from "../lib/api";
import { useAuth } from "../lib/auth";
import TicketPreview from "../components/TicketPreview";
import { QuotaMeter } from "../components/Brand";

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
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!venueId) return;
    apiFetch(`/venues/${venueId}/events`)
      .then((data) => {
        setEvents(data);
        if (data.length) setSelectedEvent(data[0].id);
      })
      .catch((e) => setError(e.message));
  }, [venueId]);

  // Recargable: se llama al cambiar de evento y tras emitir, para que el
  // medidor de cupo refleje las boletas realmente usadas.
  const loadAllocations = useCallback(async () => {
    if (!selectedEvent) return;
    try {
      setAllocations(await apiFetch(`/venues/${venueId}/events/${selectedEvent}/allocations`));
    } catch {
      setAllocations([]);
    }
  }, [selectedEvent, venueId]);

  useEffect(() => {
    if (!selectedEvent) return;
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/types`)
      .then((d) => {
        // Los tipos archivados por el admin no se ofrecen (la DB los rechaza
        // igual, con `ticket_type_inactive`).
        const active = d.filter((t) => t.is_active !== false);
        setTypes(active);
        setForm((f) => ({ ...f, ticket_type_id: active[0]?.id ?? "" }));
      })
      .catch((e) => setError(e.message));
    loadAllocations();
  }, [selectedEvent, venueId, loadAllocations]);

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
      setLastTicket({
        ...ticket,
        customerName: form.customer_name,
        customerPhone: form.customer_phone,
      });
      setCopied(false);
      setForm({ ...form, customer_name: "", customer_phone: "", customer_email: "" });
      await loadAllocations();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const eventName = events.find((ev) => ev.id === selectedEvent)?.name ?? "";
  // Entrega real: el cliente abre este link y ve su QR (sin sesión).
  const ticketUrl = lastTicket ? publicTicketImageUrl(lastTicket.raw_token) : null;

  // wa.me exige el número solo con dígitos, código de país incluido. Si viene
  // incompleto abrimos el selector de contactos en vez de un chat equivocado.
  const waDigits = String(lastTicket?.customerPhone ?? "").replace(/\D/g, "");

  const waMessage = lastTicket
    ? [
        "🎟️ Tu boleta está lista",
        `Evento: ${eventName}`,
        `Nombre: ${lastTicket.customerName ?? ""}`,
        `Boleta #${lastTicket.ticket_id}`,
        "",
        `Ábrela y guárdala aquí (el QR para entrar): ${ticketUrl}`,
      ].join("\n")
    : "";

  const waLink = lastTicket
    ? `https://wa.me/${waDigits.length >= 8 ? waDigits : ""}?text=${encodeURIComponent(waMessage)}`
    : null;

  async function copyTicketUrl() {
    try {
      await navigator.clipboard.writeText(ticketUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("No se pudo copiar el enlace. Cópialo manualmente.");
    }
  }

  return (
    <div className="animate-rise space-y-6">
      <div>
        <h2 className="text-2xl font-black tracking-tight text-white">Panel del promotor</h2>
        <p className="mt-1 text-sm text-slate-400">
          Hola {user?.full_name}. Emite boletas dentro de tu cupo asignado.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {events.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-slate-400">No hay eventos publicados todavía.</p>
          <p className="mt-1 text-sm text-slate-500">Cuando el admin publique uno, aparecerá aquí.</p>
        </div>
      )}

      {events.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Formulario */}
          <div className="card p-5">
            <h3 className="mb-3 text-sm font-bold text-slate-200">Emitir boleta</h3>

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
                <label className="mb-1 block text-xs font-medium text-slate-400">
                  Teléfono (con código de país) *
                </label>
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
          <div className="card h-fit p-5">
            <h3 className="mb-3 text-sm font-bold text-slate-200">
              {lastTicket ? "Boleta generada" : "Vista previa"}
            </h3>
            {lastTicket ? (
              <div className="animate-rise space-y-4">
                <TicketPreview
                  rawToken={lastTicket.raw_token}
                  ticketId={lastTicket.ticket_id}
                  name={lastTicket.customerName || "Asistente"}
                  eventName={eventName}
                />

                {waLink && (
                  <a
                    href={waLink}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 py-3 font-bold text-white shadow-lg shadow-emerald-500/25 transition hover:bg-emerald-400"
                  >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                      <path d="M12.04 2a9.9 9.9 0 0 0-8.51 14.93L2 22l5.2-1.49A9.9 9.9 0 1 0 12.04 2zm5.77 14.06c-.24.68-1.4 1.3-1.93 1.35-.52.05-1.01.24-3.4-.71-2.87-1.13-4.68-4.06-4.82-4.25-.14-.19-1.15-1.53-1.15-2.92 0-1.39.73-2.07 .99-2.35.26-.28.57-.35.76-.35h.55c.18 0 .42-.07.66.5.24.57.83 1.97.9 2.11.07.14.12.31.02.5-.09.19-.14.3-.28.47-.14.17-.3.38-.42.51-.14.14-.29.3-.12.58.16.28.73 1.2 1.57 1.95 1.08.96 1.99 1.26 2.27 1.4.28.14.44.12.6-.07.17-.19.7-.81.88-1.09.19-.28.38-.23.63-.14.26.09 1.63.77 1.91.91.28.14.47.21.54.33.07.12.07.68-.17 1.36z" />
                    </svg>
                    Enviar por WhatsApp
                  </a>
                )}

                {/* Lo que se le entrega al cliente: abre el QR sin sesión */}
                <div className="rounded-lg bg-slate-800/60 p-3 ring-1 ring-slate-700/50">
                  <p className="mb-1 text-xs font-medium text-slate-400">
                    Enlace de la boleta (el cliente abre aquí su QR)
                  </p>
                  <p className="break-all font-mono text-xs text-slate-300">{ticketUrl}</p>
                  <div className="mt-2 flex gap-2">
                    <a
                      href={ticketUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-ghost flex-1 text-xs font-bold"
                    >
                      Ver boleta
                    </a>
                    <button
                      type="button"
                      onClick={copyTicketUrl}
                      className="btn-ghost flex-1 text-xs font-bold"
                    >
                      {copied ? "¡Enlace copiado!" : "Copiar enlace"}
                    </button>
                  </div>
                </div>

                <details className="rounded-lg bg-slate-900/60 p-3 ring-1 ring-slate-800">
                  <summary className="cursor-pointer text-xs font-medium text-slate-500">
                    Código de respaldo (validar sin cámara)
                  </summary>
                  <p className="mt-2 break-all font-mono text-xs text-slate-400">
                    {lastTicket.raw_token}
                  </p>
                </details>
              </div>
            ) : (
              <div className="py-10 text-center">
                <div className="mx-auto mb-3 h-24 w-24 rounded-xl bg-slate-800/60 ring-1 ring-slate-700/50" />
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
