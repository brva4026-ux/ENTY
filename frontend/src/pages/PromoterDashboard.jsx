import { useEffect, useState } from "react";
import { apiFetch, listTickets, reissueTicket } from "../lib/api";
import { useAuth } from "../lib/auth";
import IssuedTicket from "../components/IssuedTicket";
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

  // Recuperación: boletas propias del evento y búsqueda por teléfono.
  const [myTickets, setMyTickets] = useState([]);
  const [phoneQuery, setPhoneQuery] = useState("");
  const [recoveringId, setRecoveringId] = useState(null);

  // El listado era admin-only, así que el promotor no podía ni ver lo que había
  // vendido: si perdía el enlace de una boleta, era irrecuperable.
  async function refreshTickets(phone) {
    if (!selectedEvent) return;
    try {
      setMyTickets(await listTickets(venueId, selectedEvent, phone));
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refreshTickets();
    setPhoneQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEvent]);

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
      // La respuesta de emision no trae telefono/email: se conservan del
      // formulario para poder armar el wa.me dirigido al invitado.
      setLastTicket({
        ...ticket,
        customerName: form.customer_name,
        customer_phone: form.customer_phone,
      });
      setForm({ ...form, customer_name: "", customer_phone: "", customer_email: "" });
      refreshTickets();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Recuperar = rotar el token. El QR viejo muere y se muestra/reenvía el nuevo,
  // que es la única forma de volver a tener un QR válido sin guardar el crudo.
  async function recover(ticket) {
    setRecoveringId(ticket.id);
    setError("");
    try {
      const fresh = await reissueTicket(venueId, selectedEvent, ticket.id, "reenvío");
      setLastTicket({
        ticket_id: fresh.ticket_id,
        raw_token: fresh.raw_token,
        customerName: fresh.customer_name,
        customer_phone: fresh.customer_phone,
      });
      await refreshTickets(phoneQuery);
    } catch (err) {
      setError(err.message);
    } finally {
      setRecoveringId(null);
    }
  }

  // El invitado no puede escanear un texto: se le manda el ENLACE a su boleta
  // (/t#<token>), donde ve el QR. El token va en el fragmento, asi que no
  // viaja al servidor en los logs ni en el Referer. El armado del enlace y
  // del mensaje de WhatsApp vive en IssuedTicket.
  const eventName = events.find((ev) => ev.id === selectedEvent)?.name;

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
              <IssuedTicket ticket={lastTicket} eventName={eventName} />
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

      {events.length > 0 && (
        <div className="card-lit card p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-200">
              <Icon name="ticket" className="h-4 w-4 text-brand-400" />
              Mis boletas
            </h3>
            <div className="flex items-center gap-2">
              <input
                value={phoneQuery}
                onChange={(e) => setPhoneQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    refreshTickets(phoneQuery);
                  }
                }}
                className="field !w-44 !py-1.5 text-xs"
                placeholder="Buscar por teléfono"
                inputMode="tel"
              />
              <button
                type="button"
                onClick={() => refreshTickets(phoneQuery)}
                className="chip tap-target"
              >
                <Icon name="search" className="h-3.5 w-3.5" />
                Buscar
              </button>
            </div>
          </div>

          {myTickets.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              {phoneQuery
                ? "No hay boletas con ese teléfono."
                : "Todavía no emitiste boletas en este evento."}
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {myTickets.map((t) => {
                const live = t.status === "issued";
                return (
                  <li key={t.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-200">
                        {t.customer_name}
                      </p>
                      <p className="tnum truncate text-xs text-slate-500">
                        Boleta #{t.id} · {t.type_name} · {t.customer_phone ?? "sin teléfono"}
                      </p>
                    </div>
                    <span
                      className={
                        live
                          ? "rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-bold text-emerald-300"
                          : "rounded-full bg-slate-700/40 px-2.5 py-0.5 text-[11px] font-bold text-slate-400"
                      }
                    >
                      {live ? "Vigente" : t.status}
                    </span>
                    <button
                      type="button"
                      disabled={!live || recoveringId === t.id}
                      onClick={() => recover(t)}
                      title={
                        live
                          ? "Genera un QR nuevo y reenvíalo"
                          : "Solo se pueden reenviar boletas vigentes"
                      }
                      className="chip tap-target disabled:opacity-40"
                    >
                      <Icon name="whatsapp" className="h-3.5 w-3.5" />
                      {recoveringId === t.id ? "Generando…" : "Reenviar"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-600">
            Reenviar genera un QR nuevo: el anterior deja de funcionar.
          </p>
        </div>
      )}
    </div>
  );
}
