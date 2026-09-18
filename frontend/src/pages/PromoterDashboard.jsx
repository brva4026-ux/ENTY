import { useCallback, useEffect, useState } from "react";
import { apiFetch, publicTicketPageUrl } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { haptics } from "../lib/haptics";
import TicketPreview from "../components/TicketPreview";
import { PullToRefresh } from "../components/PullToRefresh";
import { StatSkeletonRow } from "../components/Skeleton";
import { LiveIndicator, QuotaMeter } from "../components/Brand";

function firstVenueId(user) {
  const ids = Object.keys(user?.roles || {}).map(Number);
  return ids[0] ?? null;
}

export default function PromoterDashboard() {
  const { user } = useAuth();
  const venueId = firstVenueId(user);

  const [events, setEvents] = useState(null); // null = primera carga (skeleton)
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

  const [history, setHistory] = useState([]);
  const loadHistory = useCallback(async () => {
    if (!selectedEvent) return;
    try {
      const data = await apiFetch(`/venues/${venueId}/events/${selectedEvent}/tickets/mine`);
      setHistory(data.tickets ?? []);
    } catch {
      setHistory([]);
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
    loadHistory();
  }, [selectedEvent, venueId, loadAllocations, loadHistory]);

  // Recargar eventos periódicamente: el admin crea/publica eventos y el
  // promotor no debería necesitar recargar la página para verlos.
  const loadEvents = useCallback(async () => {
    if (!venueId) return;
    try {
      const data = await apiFetch(`/venues/${venueId}/events`);
      setEvents(data);
    } catch {
      /* el error de fondo no debe patear al promotor de su sesión */
    }
  }, [venueId]);
  const lastEventsUpdate = useLiveRefresh(loadEvents, true, 20_000);

  // Auto-refresh de cupos mientras el evento seleccionado acepta emisión
  // (published/live): si el admin ajusta cupos a mitad de evento, el medidor
  // refleja el cambio sin recargar. En draft/ended/cancelled no hay nada que
  // cambiar, así que el intervalo ni siquiera corre.
  const selectedEventData = (events ?? []).find((ev) => ev.id === selectedEvent);
  const sellingOpen = ["published", "live"].includes(selectedEventData?.status);
  const sellClosed = !!selectedEventData && !sellingOpen;
  const refreshOperational = useCallback(
    async () => Promise.all([loadAllocations(), loadHistory()]),
    [loadAllocations, loadHistory]
  );
  const lastQuotaUpdate = useLiveRefresh(refreshOperational, sellingOpen, 20_000);

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
      haptics.success();
      setCopied(false);
      setForm({ ...form, customer_name: "", customer_phone: "", customer_email: "" });
      await Promise.all([loadAllocations(), loadHistory()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const eventName = (events ?? []).find((ev) => ev.id === selectedEvent)?.name ?? "";
  // Entrega real: el cliente abre este link y ve su QR (sin sesión). Es la
  // página HTML (reenviable, con vista previa de WhatsApp), no la imagen cruda.
  const ticketUrl = lastTicket ? publicTicketPageUrl(lastTicket.raw_token) : null;

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

  // Recarga completa para pull-to-refresh.
  const reloadAll = useCallback(
    async () =>
      Promise.allSettled([
        loadEvents(),
        selectedEvent ? refreshOperational() : Promise.resolve(),
      ]),
    [loadEvents, refreshOperational, selectedEvent]
  );

  return (
    <PullToRefresh onRefresh={reloadAll}>
    <div className="reveal space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="eyebrow">TicketFlow</p>
          <h2 className="display text-2xl">Panel del promotor</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Hola {user?.full_name}. Emite boletas dentro de tu cupo asignado.
          </p>
        </div>
        <LiveIndicator
          live={sellingOpen}
          lastUpdated={lastQuotaUpdate ?? lastEventsUpdate}
        />
      </div>

      {error && (
        <div className="rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {events === null ? (
        <StatSkeletonRow count={2} />
      ) : events.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-zinc-400">No hay eventos publicados todavía.</p>
          <p className="mt-1 text-sm text-zinc-500">Cuando el admin publique uno, aparecerá aquí.</p>
        </div>
      ) : null}

      {events != null && events.length > 0 && (
        <>
          {/* Contexto del evento: siempre visible arriba, fuera del formulario */}
          <div className="card p-4">
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={selectedEvent}
                onChange={(e) => setSelectedEvent(Number(e.target.value))}
                className="field h-auto w-auto min-w-40 flex-1 py-1.5 text-sm font-semibold"
                aria-label="Evento"
              >
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>{ev.name}</option>
                ))}
              </select>
              {selectedEventData && <StatusBadge status={selectedEventData.status} />}
            </div>
            {myAllocations.length > 0 && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
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
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
          {/* Columna izquierda: formulario + historial propio */}
          <div className="space-y-6">
          <div className="card p-5">
            <h3 className="mb-3 text-sm font-bold text-zinc-200">Emitir boleta</h3>

            {sellClosed && (
              <div className="mb-3 rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-200/90">
                La emisión está cerrada: este evento aún no se publica o ya finalizó.
              </div>
            )}
            <form onSubmit={emit} hidden={sellClosed} className="space-y-3.5">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">Tipo de boleta</label>
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


              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">Nombre del asistente *</label>
                <input
                  value={form.customer_name}
                  onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
                  className="field"
                  placeholder="Nombre y apellido"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">
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
                <label className="mb-1 block text-xs font-medium text-zinc-400">Correo (opcional)</label>
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
            {myAllocations.length === 0 && (
              <p className="mt-3 text-xs text-zinc-500">
                Sin cupo asignado: puedes emitir a nombre de la venue.
              </p>
            )}
          </div>

          {/* Historial de boletas emitidas por este usuario en el evento */}
          <div className="card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-bold text-zinc-200">Mis boletas</h3>
              <span className="text-xs tnum text-zinc-500">{history.length}</span>
            </div>
            {history.length === 0 ? (
              <p className="py-4 text-center text-sm text-zinc-500">
                Todavía no has emitido boletas para este evento.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-800">
                {history.map((t) => (
                  <li key={t.ticket_id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-200">
                        #{t.ticket_id} · {t.customer_name}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {t.ticket_type}
                        {t.customer_phone ? ` · ${t.customer_phone}` : ""}
                      </p>
                    </div>
                    <TicketStatusPill status={t.status} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          </div>

          {/* Boleta resultante + wa.me */}
          <div className="card h-fit p-5">
            <h3 className="mb-3 text-sm font-bold text-zinc-200">
              {lastTicket ? "Boleta generada" : "Vista previa"}
            </h3>
            {lastTicket ? (
              <div className="animate-rise space-y-4">
                <a href={ticketUrl} target="_blank" rel="noreferrer" className="block">
                  <TicketPreview
                    rawToken={lastTicket.raw_token}
                    ticketId={lastTicket.ticket_id}
                    name={lastTicket.customerName || "Asistente"}
                    eventName={eventName}
                  />
                </a>

                {waLink && (
                  <a
                    href={waLink}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 font-semibold text-white transition hover:bg-emerald-500"
                  >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                      <path d="M12.04 2a9.9 9.9 0 0 0-8.51 14.93L2 22l5.2-1.49A9.9 9.9 0 1 0 12.04 2zm5.77 14.06c-.24.68-1.4 1.3-1.93 1.35-.52.05-1.01.24-3.4-.71-2.87-1.13-4.68-4.06-4.82-4.25-.14-.19-1.15-1.53-1.15-2.92 0-1.39.73-2.07 .99-2.35.26-.28.57-.35.76-.35h.55c.18 0 .42-.07.66.5.24.57.83 1.97.9 2.11.07.14.12.31.02.5-.09.19-.14.3-.28.47-.14.17-.3.38-.42.51-.14.14-.29.3-.12.58.16.28.73 1.2 1.57 1.95 1.08.96 1.99 1.26 2.27 1.4.28.14.44.12.6-.07.17-.19.7-.81.88-1.09.19-.28.38-.23.63-.14.26.09 1.63.77 1.91.91.28.14.47.21.54.33.07.12.07.68-.17 1.36z" />
                    </svg>
                    Enviar por WhatsApp
                  </a>
                )}

                {/* Lo que se le entrega al cliente: abre el QR sin sesión */}
                <div className="rounded-lg bg-zinc-800/60 p-3 ring-1 ring-zinc-700/50">
                  <p className="mb-1 text-xs font-medium text-zinc-400">
                    Enlace de la boleta (el cliente abre aquí su QR)
                  </p>
                  <p className="break-all font-mono text-xs text-zinc-300">{ticketUrl}</p>
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

                <details className="rounded-lg bg-zinc-900/60 p-3 ring-1 ring-zinc-800">
                  <summary className="cursor-pointer text-xs font-medium text-zinc-500">
                    Código de respaldo (validar sin cámara)
                  </summary>
                  <p className="mt-2 break-all font-mono text-xs text-zinc-400">
                    {lastTicket.raw_token}
                  </p>
                </details>
              </div>
            ) : (
              <div className="py-10 text-center">
                <div className="mx-auto mb-3 h-24 w-24 rounded-xl bg-zinc-800/60 ring-1 ring-zinc-700/50" />
                <p className="text-sm text-zinc-500">
                  Emite una boleta para ver el QR y el enlace de envío.
                </p>
              </div>
            )}
          </div>
          </div>
        </>
      )}
    </div>
    </PullToRefresh>
  );
}

function TicketStatusPill({ status }) {
  const map = {
    issued: ["Activa", "bg-zinc-800 text-zinc-300 ring-zinc-700"],
    redeemed: ["Canjeada", "bg-emerald-950/60 text-emerald-300 ring-emerald-800/60"],
    voided: ["Anulada", "bg-red-950/60 text-red-300 ring-red-800/60"],
    refunded: ["Reembolsada", "bg-zinc-800 text-zinc-400 ring-zinc-700"],
  };
  const [label, cls] = map[status] ?? [status, "bg-zinc-800 text-zinc-300 ring-zinc-700"];
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${cls}`}>
      {label}
    </span>
  );
}

function StatusBadge({ status }) {
  if (!status) return null;
  const map = {
    draft: ["Borrador", "bg-zinc-800 text-zinc-300 ring-zinc-700"],
    published: ["Venta abierta", "bg-violet-950/60 text-violet-300 ring-violet-800/60"],
    live: ["En puerta", "bg-emerald-950/60 text-emerald-300 ring-emerald-800/60"],
    ended: ["Finalizado", "bg-zinc-800 text-zinc-400 ring-zinc-700"],
    cancelled: ["Cancelado", "bg-red-950/60 text-red-300 ring-red-800/60"],
  };
  const [label, cls] = map[status] ?? [status, "bg-zinc-800 text-zinc-300 ring-zinc-700"];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${cls}`}>
      {label}
    </span>
  );
}
