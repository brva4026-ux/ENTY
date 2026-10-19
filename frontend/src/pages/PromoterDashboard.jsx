import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { haptics } from "../lib/haptics";
import IssuedTicket from "../components/IssuedTicket";
import { PullToRefresh } from "../components/PullToRefresh";
import { useUI } from "../lib/ui";
import { activeVenueId } from "../lib/venue";
import EmptyState from "../components/EmptyState";
import ContactEditsHistory from "../components/ContactEditsHistory";
import { StatSkeletonRow } from "../components/Skeleton";
import { LiveIndicator, QuotaMeter } from "../components/Brand";
import { STATUS_META, sortEventsForStrip } from "../components/EventWorkbench";
import Icon from "../components/Icon";
import useDocumentTitle from "../lib/useDocumentTitle";

function firstVenueId(user) {
  return activeVenueId(user);
}

export default function PromoterDashboard() {
  useDocumentTitle("Panel del promotor");
  const { user } = useAuth();
  const venueId = firstVenueId(user);
  // Pestaña en la URL (compartible, sobrevive recargas); "vender" es el default.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = ["vender", "boletas", "liquidaciones"].includes(
    searchParams.get("tab"),
  )
    ? searchParams.get("tab")
    : "vender";

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
  const [reissuingId, setReissuingId] = useState(null);
  // Mig 015: corrección de contacto del asistente (nombre/teléfono) con
  // auditoría en la DB. El error más común: el teléfono mal digitado y el
  // WhatsApp del QR nunca llegó.
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({ name: "", phone: "", reason: "" });
  const ui = useUI();

  useEffect(() => {
    if (!venueId) return;
    apiFetch(`/venues/${venueId}/events`)
      .then((data) => {
        setEvents(data);
        // Aterrizar en el evento que importa: el primero por prioridad
        // operativa (en puerta > a la venta > ...). Un promotor con un evento
        // en puerta NO debe llegar al panel viendo un evento terminado.
        if (data.length) setSelectedEvent(sortEventsForStrip(data)[0].id);
      })
      .catch((e) => setError(e.message));
  }, [venueId]);

  // Recargable: se llama al cambiar de evento y tras emitir, para que el
  // medidor de cupo refleje las boletas realmente usadas.
  const loadAllocations = useCallback(async () => {
    if (!selectedEvent) return;
    try {
      setAllocations(
        await apiFetch(
          `/venues/${venueId}/events/${selectedEvent}/allocations`,
        ),
      );
    } catch {
      setAllocations([]);
    }
  }, [selectedEvent, venueId]);

  const [history, setHistory] = useState([]);
  const loadHistory = useCallback(async () => {
    if (!selectedEvent) return;
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/tickets/mine`,
      );
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

  // MIS NOCHES (tanda 3): los eventos donde ESTE promotor fue asignado, con
  // su cupo agregado. La lista de la venue entera es del admin; el promotor
  // de la noche del 14 no necesita ver las otras 30 noches del calendario.
  const [myNights, setMyNights] = useState([]);
  const loadMyNights = useCallback(async () => {
    if (!venueId) return;
    try {
      setMyNights(await apiFetch(`/venues/${venueId}/events/mine`));
    } catch {
      /* silencioso: la tarjeta no aparece y ya */
    }
  }, [venueId]);
  useEffect(() => {
    loadMyNights();
  }, [loadMyNights]);

  // Auto-refresh de cupos mientras el evento seleccionado acepta emisión
  // (published/live): si el admin ajusta cupos a mitad de evento, el medidor
  // refleja el cambio sin recargar. En draft/ended/cancelled no hay nada que
  // cambiar, así que el intervalo ni siquiera corre.
  const selectedEventData = (events ?? []).find(
    (ev) => ev.id === selectedEvent,
  );
  const sellingOpen = ["published", "live"].includes(selectedEventData?.status);
  const sellClosed = !!selectedEventData && !sellingOpen;
  const refreshOperational = useCallback(
    async () => Promise.all([loadAllocations(), loadHistory()]),
    [loadAllocations, loadHistory],
  );
  const lastQuotaUpdate = useLiveRefresh(
    refreshOperational,
    sellingOpen,
    20_000,
  );

  const courtesyTypes = types.filter((t) => t.is_courtesy);
  // cupos del promotor actual, filtrados por tipo cortesía
  const myAllocations = allocations.filter(
    (a) =>
      a.promoter_id === user.id &&
      courtesyTypes.some((t) => t.id === a.ticket_type_id),
  );
  // Cupo del tipo que se está vendiendo AHORA: la duda "¿puedo emitir o ya se
  // agotó?" se responde en el formulario, donde nace la pregunta, sin subir a
  // interpretar el medidor de la cabecera.
  const selectedType = types.find(
    (t) => t.id === Number(form.ticket_type_id),
  );
  const selectedTypeAllocs = allocations.filter(
    (a) => a.promoter_id === user.id && a.ticket_type_id === selectedType?.id,
  );
  const selectedTypeCapacity = selectedTypeAllocs.reduce(
    (s, a) => s + a.capacity,
    0,
  );
  const selectedTypeIssued = selectedTypeAllocs.reduce(
    (s, a) => s + (a.issued ?? 0),
    0,
  );

  function handleTypeChange(id) {
    setForm((f) => {
      const isCourtesyType = types.find(
        (t) => t.id === Number(id),
      )?.is_courtesy;
      const alloc =
        isCourtesyType && myAllocations.length ? myAllocations[0].id : null;
      return { ...f, ticket_type_id: id, allocation_id: alloc };
    });
  }

  async function emit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const ticket = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/tickets`,
        {
          method: "POST",
          // "" no es un int válido para Pydantic: normalizar a null
          body: JSON.stringify({
            ...form,
            allocation_id: form.allocation_id || null,
          }),
        },
      );
      setLastTicket({
        ...ticket,
        customerName: form.customer_name,
        customerPhone: form.customer_phone,
      });
      haptics.success();
      setForm({
        ...form,
        customer_name: "",
        customer_phone: "",
        customer_email: "",
      });
      await Promise.all([loadAllocations(), loadHistory()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const eventName =
    (events ?? []).find((ev) => ev.id === selectedEvent)?.name ?? "";

  /** Reemite una boleta VIGENTE (mig 004): rota el token y entrega el enlace
      nuevo. Se usa cuando el invitado perdió el WhatsApp, borró el chat o el
      enlace murió con la pestaña: la boleta es la misma, solo cambia la
      credencial del QR (el enlace anterior deja de servir en el acto). */
  async function reissueTicket(t) {
    const ok = await ui.confirm(`¿Reemitir la boleta #${t.ticket_id}?`, {
      message: `Se genera un enlace NUEVO para ${t.customer_name}. El enlace anterior deja de funcionar de inmediato: si alguien ya tenía el QR viejo, ya no le sirve.`,
      confirmLabel: "Reemitir boleta",
    });
    if (!ok) return;
    setReissuingId(t.ticket_id);
    setError("");
    try {
      const res = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/tickets/${t.ticket_id}/reissue`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: "Recuperación de enlace (WhatsApp perdido o borrado)",
          }),
        },
      );
      setLastTicket({
        ...res,
        customerName: res.customer_name,
        customerPhone: res.customer_phone,
      });
      haptics.success();
      await loadHistory();
      ui.success(
        `Boleta #${t.ticket_id} reemitida: entrega el enlace nuevo de la columna derecha`,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setReissuingId(null);
    }
  }

  /** Corrección de contacto (mig 015): PATCH con auditoría en la DB. Al menos
      un campo debe venir; el backend valida teléfono y permisos (el historial
      ya solo trae boletas propias, así que el 403 no debería aparecer). */
  async function saveContact(t) {
    const name = edit.name.trim();
    const phone = edit.phone.trim();
    if (!name && !phone) {
      setError("Escribe nombre o teléfono: al menos uno.");
      return;
    }
    try {
      await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}/tickets/${t.ticket_id}/contact`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...(name ? { customer_name: name } : {}),
            ...(phone ? { customer_phone: phone } : {}),
            ...(edit.reason.trim() ? { reason: edit.reason.trim() } : {}),
          }),
        },
      );
      setEditingId(null);
      await loadHistory();
      ui.success(`Contacto de la boleta #${t.ticket_id} actualizado`);
    } catch (err) {
      setError(err.message);
    }
  }

  // Entrega: el QR, el enlace y el wa.me viven en <IssuedTicket>, compartido
  // con el panel del admin (misma boleta, mismo mensaje, un solo arreglo).
  // Desde el historial el objeto puede venir sin raw_token (nunca se guarda en
  // claro en la DB): IssuedTicket no pinta enlace hasta que se reemite.

  // Recarga completa para pull-to-refresh.
  // Liquidaciones propias: el promotor ve cuanto ha ganado y puede disputar.
  const [payouts, setPayouts] = useState(null);
  const loadPayouts = useCallback(async () => {
    try {
      setPayouts(await apiFetch(`/venues/${venueId}/payouts/mine`));
    } catch {
      setPayouts([]);
    }
  }, [venueId]);

  useEffect(() => {
    if (venueId) loadPayouts();
  }, [loadPayouts, venueId]);

  const reloadAll = useCallback(
    async () =>
      Promise.allSettled([
        loadEvents(),
        selectedEvent ? refreshOperational() : Promise.resolve(),
        loadPayouts(),
        loadMyNights(),
      ]),
    [loadEvents, refreshOperational, selectedEvent, loadPayouts, loadMyNights],
  );

  return (
    <PullToRefresh onRefresh={reloadAll}>
      <div className="reveal space-y-6">
        <div className="promo-hero">
          <div>
            <p className="eyebrow">Enty</p>
            <h1
              className="display promo-hero-title"
              style={{ fontVariationSettings: '"opsz" 32' }}
            >
              Panel del promotor
            </h1>
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
          <div className="card">
            <EmptyState icon="door" title="No hay eventos publicados todavía">
              Cuando el admin publique uno, aparecerá aquí listo para vender.
            </EmptyState>
          </div>
        ) : null}

        {events != null && events.length > 0 && (
          <>
            {/* MIS NOCHES (tanda 3): a dónde tengo que ir a trabajar. Solo
              aparece si el admin me asignó a alguna noche; con las fechas y
              mi cupo de esa noche, sin abrir el evento. */}
            {myNights.length > 0 && (
              <div className="card p-4">
                <p className="eyebrow">Mis noches</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Las noches donde te asignaron. Tu cupo es de cada evento.
                </p>
                <ul className="mt-3 space-y-2">
                  {myNights.map((n) => {
                    const meta = STATUS_META[n.status] ?? STATUS_META.draft;
                    const activa = n.id === selectedEvent;
                    const restantes = Math.max(0, n.my_capacity - n.my_issued);
                    const pct = n.my_capacity > 0
                      ? Math.min(100, Math.round((n.my_issued / n.my_capacity) * 100))
                      : 0;
                    const fillCls =
                      restantes === 0
                        ? "is-full"
                        : restantes <= Math.ceil(n.my_capacity * 0.2)
                          ? "is-warn"
                          : "";
                    return (
                      <li key={n.id}>
                        <button
                          onClick={() => setSelectedEvent(n.id)}
                          className={`flex w-full flex-col gap-2 rounded-lg px-3 py-2.5 text-left transition ${
                            activa
                              ? "bg-brand-500/10 ring-1 ring-brand-500/40"
                              : "bg-zinc-940 hover:bg-zinc-900"
                          }`}
                        >
                          <div className="flex w-full items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-zinc-100">
                              {n.name}
                            </p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-zinc-500">
                              {new Date(n.starts_at).toLocaleString("es-CO", {
                                weekday: "short",
                                day: "numeric",
                                month: "short",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                              <span
                                className={`rounded-full px-1.5 py-0.5 text-2xs font-bold uppercase ring-1 ${meta.cls}`}
                              >
                                {meta.label}
                              </span>
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="tnum text-sm font-bold text-zinc-100">
                              {n.my_issued}
                              <span className="text-xs text-zinc-500">
                                /{n.my_capacity}
                              </span>
                            </p>
                            <p className="text-2xs text-zinc-500">
                              {restantes === 0
                                ? "cupo agotado"
                                : `te quedan ${restantes}`}
                            </p>
                          </div>
                        </div>
                        {/* Medidor de cupo: la proporción de la noche, viva. */}
                        <span className="e-meter w-full" aria-hidden="true">
                          <span
                            className={`e-meter-fill ${fillCls}`}
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Contexto del evento: siempre visible arriba, fuera del formulario.
              Selector premium: el estado en español con su color en CADA opción. */}
            <div className="card card-hero p-4">
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={selectedEvent}
                  onChange={(e) => setSelectedEvent(Number(e.target.value))}
                  className="field h-auto w-auto min-w-40 flex-1 py-1.5 text-sm font-semibold"
                  aria-label="Evento"
                >
                  {sortEventsForStrip(events).map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.name} —{" "}
                      {(STATUS_META[ev.status] ?? STATUS_META.draft).label}
                    </option>
                  ))}
                </select>
                {selectedEventData && (
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-2xs font-bold uppercase ring-1 ${
                      (
                        STATUS_META[selectedEventData.status] ??
                        STATUS_META.draft
                      ).cls
                    }`}
                  >
                    {
                      (
                        STATUS_META[selectedEventData.status] ??
                        STATUS_META.draft
                      ).label
                    }
                  </span>
                )}
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
              {/* Cambio de equipo (tanda 3): el admin puede sacar a alguien del
                  roster de una noche. Si este promotor está asignado a otras
                  noches pero NO a la que tiene abierta, se lo decimos antes de
                  que intente vender un cupo que ya no le toca. */}
              {myNights.length > 0 &&
                selectedEvent &&
                !myNights.some((n) => n.id === selectedEvent) && (
                  <div className="mt-3 rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-2.5 text-xs text-amber-200/90">
                    Ya no estás asignado a esta noche. Si necesitás vender acá,
                    pedile al admin que te sume otra vez.
                  </div>
                )}
            </div>

            {/* ====== Pestañas: Vender · Mis boletas · Mis liquidaciones ======
              Una cosa por pantalla (en el celular, una cosa por scroll). La
              pestaña vive en la URL: /promotor?tab=boletas es compartible,
              sobrevive recargas y back. "Vender" es el default: es lo que el
              promotor abre para. */}
            <nav
              className="tabbar no-scrollbar max-w-full"
              aria-label="Secciones del promotor"
            >
              {[
                ["vender", "Vender", "ticket"],
                ["boletas", "Mis boletas", "search"],
                ["liquidaciones", "Liquidaciones", "money"],
              ].map(([id, label, icon]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setSearchParams({ tab: id })}
                  className="tabbar-item flex-1 sm:flex-none"
                >
                  <Icon name={icon} className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </nav>

            {tab === "vender" && (
              <div className="grid gap-6 lg:grid-cols-2">
                {/* Columna izquierda: formulario + historial propio */}
                <div className="space-y-6">
                  <div className="card p-5">
                    <h3 className="mb-3 text-sm font-bold text-zinc-200">
                      Emitir boleta
                    </h3>

                    {sellClosed && (
                      <div className="mb-3 rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-200/90">
                        La emisión está cerrada: este evento aún no se publica o
                        ya finalizó.
                      </div>
                    )}
                    <form
                      onSubmit={emit}
                      hidden={sellClosed}
                      className="space-y-3.5"
                    >
                      <div>
                        <label className="mb-1 block text-xs font-medium text-zinc-400">
                          Tipo de boleta
                        </label>
                        <select
                          value={form.ticket_type_id}
                          onChange={(e) => handleTypeChange(e.target.value)}
                          className="field"
                          required
                        >
                          {types.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}{" "}
                              {t.price_cents > 0
                                ? `$${(t.price_cents / 100).toLocaleString("es-CO")}`
                                : "(cortesía)"}
                            </option>
                          ))}
                        </select>
                        {/* Cuánto queda EN ESTE TIPO: si el cupo del tipo ya se
                            agotó, el promotor se entera acá y no después del
                            rechazo de la DB. */}
                        {selectedTypeCapacity > 0 &&
                          (selectedTypeIssued >= selectedTypeCapacity ? (
                            <p className="mt-1 text-2xs font-semibold text-amber-300">
                              Sin cupo en este tipo: no podés emitir más acá.
                            </p>
                          ) : (
                            <p className="mt-1 text-2xs text-zinc-500">
                              Te quedan{" "}
                              <strong className="tnum text-zinc-300">
                                {selectedTypeCapacity - selectedTypeIssued}
                              </strong>{" "}
                              de {selectedTypeCapacity} en este tipo.
                            </p>
                          ))}
                      </div>

                      <div>
                        <label className="mb-1 block text-xs font-medium text-zinc-400">
                          Nombre del asistente *
                        </label>
                        <input
                          value={form.customer_name}
                          onChange={(e) =>
                            setForm({ ...form, customer_name: e.target.value })
                          }
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
                          onChange={(e) =>
                            setForm({ ...form, customer_phone: e.target.value })
                          }
                          className="field"
                          placeholder="573001234567"
                          inputMode="tel"
                          required
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-zinc-400">
                          Correo (opcional)
                        </label>
                        <input
                          value={form.customer_email}
                          onChange={(e) =>
                            setForm({ ...form, customer_email: e.target.value })
                          }
                          className="field"
                          type="email"
                          placeholder="asistente@correo.com"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={busy}
                        className={
                          lastTicket ? "btn-ghost w-full" : "btn-primary w-full"
                        }
                      >
                        {busy && (
                          <svg
                            className="btn-spinner"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <circle cx="12" cy="12" r="9" />
                          </svg>
                        )}
                        {busy
                          ? "Emitiendo…"
                          : lastTicket
                            ? "Emitir otra boleta"
                            : "Emitir boleta"}
                      </button>
                    </form>
                    {myAllocations.length === 0 && (
                      <p className="mt-3 text-xs text-zinc-500">
                        Sin cupo asignado: puedes emitir a nombre de la venue.
                      </p>
                    )}
                  </div>
                </div>

                {/* Boleta resultante + wa.me */}
                <div className="card h-fit p-5">
                  <h3 className="mb-3 text-sm font-bold text-zinc-200">
                    {lastTicket ? "Boleta generada" : "Vista previa"}
                  </h3>
                  {lastTicket ? (
                    <IssuedTicket
                      ticket={lastTicket}
                      eventName={eventName}
                    />
                  ) : (
                    <div className="py-8 text-center">
                      {/* Estado vacío del preview: mini-boleta abstracta, no un
                    rectángulo vacío. Mismo lenguaje visual que EmptyState. */}
                      <div
                        className="ticket-ghost mx-auto mb-4 h-28 w-28"
                        aria-hidden
                      />
                      <p className="display text-base">Tu próxima boleta</p>
                      <p className="mx-auto mt-1 max-w-56 text-sm text-zinc-500">
                        Llena los datos y emite: aquí aparece el QR listo para
                        enviar por WhatsApp.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === "boletas" && (
              <div className="card p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-bold text-zinc-200">
                    Mis boletas
                  </h3>
                  <span className="text-xs tnum text-zinc-500">
                    {history.length}
                  </span>
                </div>
                {history.length === 0 ? (
                  <p className="py-4 text-center text-sm text-zinc-500">
                    Todavía no has emitido boletas para este evento.
                  </p>
                ) : (
                  <ul className="divide-y divide-zinc-800">
                    {history.map((t) => (
                      <li
                        key={t.ticket_id}
                        className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-zinc-200">
                            #{t.ticket_id} · {t.customer_name}
                          </p>
                          <p className="text-xs text-zinc-500">
                            {t.ticket_type}
                            {t.customer_phone ? ` · ${t.customer_phone}` : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {t.status === "issued" && (
                            <>
                              <button
                                onClick={() => reissueTicket(t)}
                                disabled={
                                  reissuingId === t.ticket_id ||
                                  editingId === t.ticket_id
                                }
                                className="btn-mini"
                                data-variant="brand"
                              >
                                {reissuingId === t.ticket_id && (
                                  <svg
                                    className="btn-spinner"
                                    viewBox="0 0 24 24"
                                    aria-hidden="true"
                                  >
                                    <circle cx="12" cy="12" r="9" />
                                  </svg>
                                )}
                                {reissuingId === t.ticket_id
                                  ? "Reemitindo…"
                                  : "Reemitir"}
                              </button>
                              <button
                                onClick={() => {
                                  setEditingId(
                                    editingId === t.ticket_id
                                      ? null
                                      : t.ticket_id,
                                  );
                                  setEdit({
                                    name: t.customer_name ?? "",
                                    phone: t.customer_phone ?? "",
                                    reason: "",
                                  });
                                }}
                                disabled={reissuingId === t.ticket_id}
                                className="btn-mini"
                              >
                                Corregir
                              </button>
                            </>
                          )}
                          <TicketStatusPill status={t.status} />
                        </div>
                        {editingId === t.ticket_id && (
                          <div className="w-full space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                            <p className="text-xs font-semibold text-zinc-400">
                              Corregir contacto · queda en auditoría
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <input
                                value={edit.name}
                                onChange={(e) =>
                                  setEdit({ ...edit, name: e.target.value })
                                }
                                className="field !py-1.5 text-xs sm:flex-1"
                                placeholder="Nombre del asistente"
                              />
                              <input
                                value={edit.phone}
                                onChange={(e) =>
                                  setEdit({ ...edit, phone: e.target.value })
                                }
                                className="field !py-1.5 text-xs sm:flex-1"
                                placeholder="Teléfono (WhatsApp)"
                                inputMode="tel"
                              />
                            </div>
                            <div className="flex gap-2">
                              <input
                                value={edit.reason}
                                onChange={(e) =>
                                  setEdit({ ...edit, reason: e.target.value })
                                }
                                className="field !py-1.5 flex-1 text-xs"
                                placeholder="Motivo (opcional): quedó mal escrito, cambió de número…"
                              />
                              <button
                                onClick={() => saveContact(t)}
                                disabled={
                                  !edit.name.trim() && !edit.phone.trim()
                                }
                                className="btn-primary !px-3 !py-1.5 text-xs"
                              >
                                Guardar
                              </button>
                              <button
                                onClick={() => setEditingId(null)}
                                className="btn-mini"
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        )}
                        <ContactEditsHistory
                          venueId={venueId}
                          eventId={selectedEvent}
                          ticket={t}
                          ticketIdField="ticket_id"
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* ====== MIS LIQUIDACIONES ====== */}
            {tab === "liquidaciones" && (
              <MyPayouts
                venueId={venueId}
                payouts={payouts}
                onReload={loadPayouts}
              />
            )}
          </>
        )}
      </div>
    </PullToRefresh>
  );
}

/* Panel de liquidaciones del promotor: cuanto gano, en que estado, y la
   disputa si no cuadra. El dinero se calcula del lado del backend. */
function MyPayouts({ venueId, payouts, onReload }) {
  const ui = useUI();
  const [disputeFor, setDisputeFor] = useState(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");

  if (!payouts) return null;

  const fmt = (c) =>
    `$${Math.round((c || 0) / 100).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;

  async function submitDispute(p) {
    setErr("");
    try {
      await apiFetch(`/venues/${venueId}/payouts/${p.id}/dispute`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      setDisputeFor(null);
      setReason("");
      onReload();
      ui.success("Disputa enviada: el admin la revisará");
    } catch (e2) {
      setErr(e2.message);
    }
  }

  const pending = payouts.filter(
    (p) => p.status === "pending" || p.status === "disputed",
  );
  const paidTotal = payouts
    .filter((p) => p.status === "paid")
    .reduce((acc, p) => acc + (p.paid_cents || 0), 0);

  return (
    <div className="card p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="eyebrow">Tus ganancias</p>
          <h3 className="display mt-0.5 text-base">Mis liquidaciones</h3>
        </div>
        <p className="tnum text-sm text-zinc-400">
          Pagado:{" "}
          <span className="font-semibold text-emerald-400">
            {fmt(paidTotal)}
          </span>
        </p>
      </div>

      {payouts.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Cuando el admin cierre un periodo con tus ventas, tu liquidación
          aparecerá aquí.
        </p>
      ) : (
        <ul className="divide-list overflow-hidden rounded-lg border border-zinc-800/80">
          {payouts.map((p) => (
            <li key={p.id} className="px-3.5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="tnum text-sm font-semibold text-zinc-200">
                    {p.period_start} → {p.period_end}
                  </p>
                  <p className="tnum text-xs text-zinc-500">
                    {p.tickets_count} boletas · {fmt(p.revenue_cents)} ·{" "}
                    {p.commission_pct}%
                  </p>
                  {p.disputed_reason && (
                    <p className="mt-1 text-xs text-amber-400">
                      Tu disputa: {p.disputed_reason}
                    </p>
                  )}
                  {p.review_note && (
                    <p className="mt-1 text-xs text-zinc-500">
                      Respuesta: {p.review_note}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="tnum display text-lg text-white">
                    {fmt(
                      p.status === "paid" ? p.paid_cents : p.commission_cents,
                    )}
                  </p>
                  <StatusPill
                    status={p.status}
                    onDispute={
                      p.status === "pending"
                        ? () => {
                            setDisputeFor(disputeFor === p.id ? null : p.id);
                            setReason("");
                          }
                        : null
                    }
                  />
                </div>
              </div>
              {disputeFor === p.id && (
                <div className="mt-2 space-y-2">
                  {err && <p className="text-xs text-red-400">{err}</p>}
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="field min-h-20 text-sm"
                    placeholder="Explica qué no cuadra (mínimo 10 caracteres)…"
                    maxLength={500}
                  />
                  <button
                    onClick={() => submitDispute(p)}
                    disabled={reason.trim().length < 10}
                    className="btn-primary px-3 py-1 text-xs font-bold disabled:opacity-40"
                  >
                    Enviar disputa
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {pending.length > 0 && (
        <p className="mt-2 text-xs text-zinc-600">
          {pending.length} liquidación{pending.length > 1 ? "es" : ""} por
          confirmar — si algo no cuadra, dispútala antes de que se pague.
        </p>
      )}
    </div>
  );
}

function StatusPill({ status, onDispute }) {
  const map = {
    pending: ["Pendiente", "bg-amber-950/60 text-amber-300 ring-amber-800/60"],
    disputed: ["En disputa", "bg-red-950/60 text-red-300 ring-red-800/60"],
    paid: ["Pagada", "bg-emerald-950/60 text-emerald-300 ring-emerald-800/60"],
    rejected: ["Rechazada", "bg-zinc-800 text-zinc-400 ring-zinc-700"],
  };
  const [label, cls] = map[status] ?? [
    status,
    "bg-zinc-800 text-zinc-300 ring-zinc-700",
  ];
  return (
    <span className="mt-1 inline-flex items-center gap-1.5">
      <span
        className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-2xs font-bold uppercase ring-1 ${cls}`}
      >
        {label}
      </span>
      {onDispute && (
        <button
          onClick={onDispute}
          className="text-2xs font-bold text-zinc-500 underline hover:text-zinc-300"
        >
          disputar
        </button>
      )}
    </span>
  );
}

function TicketStatusPill({ status }) {
  const map = {
    issued: ["Activa", "bg-zinc-800 text-zinc-300 ring-zinc-700"],
    redeemed: [
      "Canjeada",
      "bg-emerald-950/60 text-emerald-300 ring-emerald-800/60",
    ],
    voided: ["Anulada", "bg-red-950/60 text-red-300 ring-red-800/60"],
    refunded: ["Reembolsada", "bg-zinc-800 text-zinc-400 ring-zinc-700"],
  };
  const [label, cls] = map[status] ?? [
    status,
    "bg-zinc-800 text-zinc-300 ring-zinc-700",
  ];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-2xs font-semibold ring-1 ${cls}`}
    >
      {label}
    </span>
  );
}
