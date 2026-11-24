import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Icon from "../../components/Icon";
import TransitionLink from "../../components/TransitionLink";
import { PromoterAlert, PromoterDrawer, PromoterEmpty, PromoterSkeleton } from "../../components/PromoterUI";
import { PromoterTicketCard, PromoterTicketFullscreen } from "../../components/PromoterTicket";
import { useAuth } from "../../lib/auth";
import { useUI } from "../../lib/ui";
import { activeVenueId } from "../../lib/venue";
import {
  apiFetch,
  fetchPromoterEvent,
  fetchPromoterLink,
  fetchTicketByRequest,
  reissueTicket,
} from "../../lib/api";
import { eventDate, money } from "../../lib/format";
import {
  availableSummary,
  eventStatusLabel,
  priceLabel,
  saleReasonLabel,
  ticketMessage,
  ticketShareUrl,
  waDigits,
} from "../../lib/promoter";

const STEPS = ["Tipo", "Datos", "Confirmar"];

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function modeLabel(type, mode) {
  if (mode === "quota") return `Cupo asignado · ${type.my_remaining} restantes`;
  if (type.price_cents > 0) return "Venta directa a nombre de la organización";
  return "Cortesía a nombre de la organización";
}

function Cover({ event, large = false }) {
  const date = event.starts_at ? new Date(event.starts_at) : null;
  const valid = date && !Number.isNaN(date.getTime());
  return (
    <div
      className={large ? "promoter-cover promoter-event-hero-cover" : "promoter-cover"}
      data-cat={event.category || "Fiesta"}
    >
      {event.flyer_url ? (
        <img src={event.flyer_url} alt="" loading="lazy" decoding="async" />
      ) : null}
      <span className="promoter-cover-label">{event.category || "Evento"}</span>
      {valid && (
        <span className={large ? "promoter-cover-date is-large" : "promoter-cover-date"}>
          <b>{date.getDate()}</b>
          <span>{date.toLocaleDateString("es-CO", { month: "short" })}</span>
        </span>
      )}
    </div>
  );
}

export default function PromoterEventView() {
  const { pathname } = useLocation();
  const eventId = pathname.split("/").filter(Boolean).pop();
  const { user } = useAuth();
  const ui = useUI();
  const nav = useNavigate();
  const venueId = activeVenueId(user);
  const [event, setEvent] = useState(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState(1);
  const [typeId, setTypeId] = useState(null);
  const [mode, setMode] = useState(null);
  const [allocationId, setAllocationId] = useState(null);
  const [form, setForm] = useState({
    customer_name: "",
    customer_phone: "",
    customer_email: "",
    customer_birth_date: "",
    payment_method: "efectivo",
  });
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastTicket, setLastTicket] = useState(null);
  const [showTicket, setShowTicket] = useState(false);
  const [copied, setCopied] = useState(false);
  const [kit, setKit] = useState(null);
  const [kitError, setKitError] = useState("");
  const [kitText, setKitText] = useState("");
  const [showShare, setShowShare] = useState(false);
  const requestRef = useRef("");
  const formDirty = step > 1 && Boolean(form.customer_name || form.customer_phone || form.customer_email);

  const selectedType = useMemo(
    () => event?.ticket_types.find((t) => t.id === typeId) || null,
    [event, typeId],
  );

  async function load() {
    if (!venueId || !eventId) return;
    setError("");
    try {
      const data = await fetchPromoterEvent(venueId, eventId);
      setEvent(data);
    } catch (err) {
      setError(err.message || "No pudimos abrir este evento.");
    }
  }

  async function loadKit() {
    if (!venueId || !eventId) return;
    try {
      const data = await fetchPromoterLink(venueId, eventId);
      setKit(data);
      setKitText(
        `Estoy vendiendo boletas para ${event?.name || "este evento"}. ` +
          `Compra la tuya aquí: ${data.url}`,
      );
    } catch (err) {
      setKitError(err.message || "El kit estará disponible cuando tengas asignación.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, eventId]);

  useEffect(() => {
    if (!event) return;
    loadKit();
    if (window.location.hash === "#kit") {
      setTimeout(() => document.getElementById("kit")?.scrollIntoView({ behavior: "smooth" }), 80);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id]);

  function chooseType(type) {
    if (!type.modes.length) return;
    setTypeId(type.id);
    setMode(type.modes[0]);
    const alloc = (event.allocations || []).find(
      (a) => a.ticket_type_id === type.id && a.is_active,
    );
    setAllocationId(type.modes[0] === "quota" ? alloc?.id ?? null : null);
    setFormError("");
  }

  async function changeEvent() {
    if (formDirty && !(await ui.confirm("¿Salir de este evento?", {
      body: "Los datos del invitado que empezaste a escribir se perderán.",
      confirmLabel: "Salir",
      danger: true,
    }))) return;
    nav("/promotor");
  }

  function validateStep2() {
    if (!form.customer_name.trim()) return "Escribe el nombre del invitado.";
    if (!form.customer_phone.trim()) {
      return "Escribe el teléfono del invitado (con indicativo del país).";
    }
    if (waDigits(form.customer_phone).length < 10) {
      return "El teléfono debe incluir el indicativo del país (mínimo 10 dígitos).";
    }
    if (selectedType?.price_cents > 0 && !form.payment_method) {
      return "Elige cómo se pagó esta boleta.";
    }
    if (event.min_age && !form.customer_birth_date) {
      return `Este evento es para ${event.min_age}+: registra la fecha de nacimiento.`;
    }
    return "";
  }

  function goReview() {
    const problem = validateStep2();
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError("");
    setStep(3);
  }

  async function emit() {
    if (busy) return;
    if (!requestRef.current) requestRef.current = uid();
    const requestId = requestRef.current;
    setBusy(true);
    setFormError("");
    const payload = {
      ticket_type_id: selectedType.id,
      allocation_id: allocationId,
      customer_name: form.customer_name.trim(),
      customer_phone: form.customer_phone.trim() || null,
      customer_email: form.customer_email.trim() || null,
      customer_birth_date: form.customer_birth_date || null,
      payment_method: selectedType.price_cents > 0 ? form.payment_method : null,
      client_request_id: requestId,
    };
    try {
      const res = await apiFetch(`/venues/${venueId}/events/${eventId}/tickets`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      completeTicket(res, payload);
    } catch (err) {
      // Un 4xx es una regla de negocio (cupo, edad, validación): reintentar
      // la consulta idempotente no lo arregla y solo haría esperar de más.
      if (err.status && err.status < 500) {
        setFormError(err.message || "No pudimos emitir la boleta.");
        return;
      }
      // La respuesta puede perderse DESPUÉS de que el servidor guardó la
      // boleta. Antes de mostrar error se consulta la clave idempotente.
      setFormError("No recibimos la confirmación. Estamos comprobando si la boleta quedó emitida…");
      for (let i = 0; i < 5; i += 1) {
        await new Promise((r) => setTimeout(r, 700 + i * 400));
        try {
          const found = await fetchTicketByRequest(venueId, eventId, requestId);
          completeTicket(found, payload, true);
          setBusy(false);
          return;
        } catch {
          /* sigue intentando */
        }
      }
      setFormError(err.message || "No pudimos emitir la boleta. Revisa el cupo e intenta de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  function completeTicket(res, payload, recovered = false) {
    const ticket = {
      ticket_id: res.ticket_id,
      raw_token: res.raw_token,
      duplicate: res.duplicate || recovered,
      sale_channel: res.sale_channel,
      customer_name: payload.customer_name,
      customer_phone: payload.customer_phone,
      event_name: event.name,
      venue_name: event.venue_name,
      ticket_type: selectedType.name,
      event_starts_at: event.starts_at,
    };
    setLastTicket(ticket);
    setStep(4);
    requestRef.current = "";
    setForm({
      customer_name: "",
      customer_phone: "",
      customer_email: "",
      customer_birth_date: "",
      payment_method: "efectivo",
    });
    load();
    loadKit();
  }

  async function reissueLast() {
    if (!lastTicket || busy) return;
    setBusy(true);
    try {
      const res = await reissueTicket(
        venueId,
        eventId,
        lastTicket.ticket_id,
        "Enlace de entrega reemitido por el promotor",
      );
      setLastTicket((prev) => ({ ...prev, raw_token: res.raw_token }));
      ui.toast("Enlace nuevo listo. El anterior ya no sirve.", "success");
    } catch (err) {
      ui.error(err.message || "No pudimos generar el enlace.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text, message = "Copiado.") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      ui.toast(message, "success");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      ui.error("No pudimos copiar. Selecciona el texto y cópialo manualmente.");
    }
  }

  function resetSale() {
    setStep(1);
    setTypeId(null);
    setMode(null);
    setAllocationId(null);
    setLastTicket(null);
    setFormError("");
    requestRef.current = "";
  }

  if (error) {
    return (
      <div className="promoter-page">
        <PromoterAlert tone="danger" action={<button type="button" onClick={load}>Reintentar</button>}>
          {error}
        </PromoterAlert>
        <TransitionLink to="/promotor" className="promoter-btn">Volver a Mis eventos</TransitionLink>
      </div>
    );
  }

  if (!event) return <PromoterSkeleton rows={2} />;

  const ticketUrl = lastTicket?.raw_token ? ticketShareUrl(lastTicket.raw_token) : "";
  const waHref = lastTicket?.raw_token && waDigits(lastTicket.customer_phone)
    ? `https://wa.me/${waDigits(lastTicket.customer_phone)}?text=${encodeURIComponent(
        ticketMessage({
          customerName: lastTicket.customer_name,
          eventName: lastTicket.event_name,
          ticketId: lastTicket.ticket_id,
          url: ticketUrl,
        }),
      )}`
    : null;

  return (
    <div className="promoter-page">
      <section className="promoter-event-hero">
        <Cover event={event} large />
        <div className="promoter-event-hero-body">
          <div className="promoter-card-top">
            <span className={`promoter-status promoter-status--${event.status === "live" ? "ok" : event.status === "ended" ? "danger" : "neutral"}`}>
              {eventStatusLabel(event.status)}
            </span>
            <span className="promoter-hint">{event.venue_name}</span>
          </div>
          <h1 className="promoter-event-title">{event.name}</h1>
          <div className="promoter-event-meta">
            <span><Icon name="calendar" className="h-3.5 w-3.5" aria-hidden="true" />{eventDate(event.starts_at)}</span>
            {event.location && <span><Icon name="door" className="h-3.5 w-3.5" aria-hidden="true" />{event.location}</span>}
            {event.doors_open_at && <span>Puertas: {eventDate(event.doors_open_at)}</span>}
          </div>
          <div className="promoter-card-stats">
            <span className="promoter-stat"><b>{event.my_issued}</b><span>Emitidas</span></span>
            <span className="promoter-stat"><b>{event.my_capacity}</b><span>Mi cupo</span></span>
            <span className="promoter-stat"><b>{event.link_sold}</b><span>Por link</span></span>
            <span className="promoter-stat"><b>{event.available_total}</b><span>Disponibles</span></span>
          </div>
          <div className="promoter-event-actions">
            <button type="button" className="promoter-btn" onClick={changeEvent}>
              <Icon name="back" aria-hidden="true" />
              Cambiar evento
            </button>
            <TransitionLink to={`/promotor/ventas?event_id=${event.id}`} className="promoter-btn">
              <Icon name="ticket" aria-hidden="true" />
              Mis ventas del evento
            </TransitionLink>
          </div>
        </div>
      </section>

      {!event.assignment_active && (
        <PromoterAlert tone="warn">
          Tu asignación a este evento fue retirada. Puedes consultar tus ventas,
          pero no emitir boletas nuevas.
        </PromoterAlert>
      )}

      <div className="promoter-event-layout">
        <section className="promoter-panel" aria-labelledby="vender-title">
          <div className="promoter-panel-head">
            <div>
              <h2 className="promoter-panel-title" id="vender-title">Vender</h2>
              <p className="promoter-panel-hint">
                Emite una boleta, entrégala por WhatsApp y confirma el ingreso.
              </p>
            </div>
          </div>

          {!event.can_sell && !lastTicket ? (
            <PromoterEmpty icon="lock" title="Venta cerrada">
              {saleReasonLabel(event.sell_reason)}
            </PromoterEmpty>
          ) : step === 4 && lastTicket ? (
            <div className="promoter-success">
              <h3>
                <Icon name="check" className="mr-1 inline h-4 w-4" aria-hidden="true" />
                {lastTicket.duplicate ? "La boleta ya estaba emitida" : "Boleta emitida"}
              </h3>
              <p>
                {lastTicket.customer_name} · {lastTicket.ticket_type} · Boleta #{String(lastTicket.ticket_id).padStart(4, "0")}
              </p>
              {lastTicket.duplicate && (
                <PromoterAlert tone="warn">
                  Recuperamos el intento anterior. Por seguridad no se vuelve a
                  mostrar el QR: genera un enlace nuevo si necesitas entregarlo.
                </PromoterAlert>
              )}
              {!lastTicket.raw_token && (
                <button type="button" className="promoter-btn promoter-btn--primary" onClick={reissueLast} disabled={busy}>
                  <Icon name="link" aria-hidden="true" />
                  {busy ? "Generando…" : "Generar enlace nuevo"}
                </button>
              )}
              {lastTicket.raw_token && (
                <>
                  <PromoterTicketCard
                    token={lastTicket.raw_token}
                    ticketId={lastTicket.ticket_id}
                    name={lastTicket.customer_name}
                    eventName={lastTicket.event_name}
                    venueName={lastTicket.venue_name}
                    ticketType={lastTicket.ticket_type}
                    startsAt={lastTicket.event_starts_at}
                    compact
                  />
                  <div className="promoter-actions-row">
                    <button type="button" className="promoter-btn promoter-btn--primary" onClick={() => setShowTicket(true)}>
                      <Icon name="eye" aria-hidden="true" />
                      Ver boleta
                    </button>
                    {waHref ? (
                      <a className="promoter-btn promoter-btn--ok" href={waHref} target="_blank" rel="noreferrer">
                        <Icon name="whatsapp" aria-hidden="true" />
                        Enviar por WhatsApp
                      </a>
                    ) : (
                      <button type="button" className="promoter-btn" onClick={() => setShowShare(true)}>
                        <Icon name="link" aria-hidden="true" />
                        Compartir enlace
                      </button>
                    )}
                    <button type="button" className="promoter-btn" onClick={() => copy(ticketUrl, "Enlace de la boleta copiado.")}>
                      <Icon name="copy" aria-hidden="true" />
                      {copied ? "Copiado" : "Copiar enlace"}
                    </button>
                  </div>
                  <p className="promoter-hint">
                    El QR se muestra una sola vez. Si el invitado pierde el enlace,
                    genera uno nuevo: el anterior deja de funcionar.
                  </p>
                </>
              )}
              <div className="promoter-actions-row">
                <button type="button" className="promoter-btn" onClick={resetSale}>Emitir otra</button>
                <button type="button" className="promoter-btn" onClick={changeEvent}>Cambiar evento</button>
              </div>
            </div>
          ) : (
            <>
              <div className="promoter-stepper" aria-label="Pasos de la venta">
                {STEPS.map((label, i) => (
                  <span key={label} className={`promoter-step${step >= i + 1 ? " is-on" : ""}`}>
                    <b>{i + 1}</b>{label}
                  </span>
                ))}
              </div>

              {step === 1 && (
                <div className="promoter-type-grid" role="radiogroup" aria-label="Tipo de boleta">
                  {event.ticket_types.filter((t) => t.is_active).length === 0 && (
                    <PromoterEmpty icon="ticket" title="Sin tipos de boleta activos">
                      La organización todavía no habilitó boletas para este evento.
                    </PromoterEmpty>
                  )}
                  {event.ticket_types.filter((t) => t.is_active).map((t) => {
                    const disabled = !t.modes.length;
                    const selected = t.id === typeId;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={disabled}
                        className={`promoter-type-card${selected ? " is-selected" : ""}${disabled ? " is-disabled" : ""}`}
                        onClick={() => chooseType(t)}
                      >
                        <span className="promoter-type-row">
                          <span className="promoter-type-name">{t.name}</span>
                          <span className="promoter-type-price">{priceLabel(t.price_cents)}</span>
                        </span>
                        <span className="promoter-type-meta">
                          {t.is_courtesy && t.my_capacity > 0
                            ? `${t.my_remaining} de ${t.my_capacity} en tu cupo`
                            : `${t.available} disponibles en el evento`}
                        </span>
                        <span className="promoter-type-modes">
                          {t.modes.map((m) => <span key={m}>{m === "quota" ? "Mi cupo" : t.price_cents > 0 ? "Venta directa" : "A nombre de la organización"}</span>)}
                          {disabled && <span>Sin disponibilidad</span>}
                        </span>
                      </button>
                    );
                  })}
                  {selectedType && (
                    <p className="promoter-hint">
                      {modeLabel(selectedType, mode)}. {selectedType.price_cents > 0
                        ? "Se registra como venta directa tuya."
                        : "Descuenta de tu cupo asignado."}
                    </p>
                  )}
                  <div className="promoter-actions-row">
                    <button
                      type="button"
                      className="promoter-btn promoter-btn--primary"
                      disabled={!selectedType || !selectedType.modes.length}
                      onClick={() => setStep(2)}
                    >
                      Continuar
                      <Icon name="arrowRight" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <form className="promoter-form" onSubmit={(e) => { e.preventDefault(); goReview(); }}>
                  <div className="promoter-field">
                    <label className="promoter-label" htmlFor="promo-name">Nombre del invitado *</label>
                    <input
                      id="promo-name"
                      className="promoter-input"
                      value={form.customer_name}
                      onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
                      autoComplete="name"
                      data-dialog-autofocus
                    />
                  </div>
                  <div className="promoter-field">
                    <label className="promoter-label" htmlFor="promo-phone">Teléfono con indicativo *</label>
                    <input
                      id="promo-phone"
                      className="promoter-input"
                      value={form.customer_phone}
                      onChange={(e) => setForm((f) => ({ ...f, customer_phone: e.target.value }))}
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="573001234567"
                    />
                    <span className="promoter-hint">Sin teléfono válido no se puede abrir WhatsApp; el enlace se puede copiar.</span>
                  </div>
                  <div className="promoter-field">
                    <label className="promoter-label" htmlFor="promo-email">Correo (opcional)</label>
                    <input
                      id="promo-email"
                      type="email"
                      className="promoter-input"
                      value={form.customer_email}
                      onChange={(e) => setForm((f) => ({ ...f, customer_email: e.target.value }))}
                      autoComplete="email"
                    />
                  </div>
                  {event.min_age ? (
                    <div className="promoter-field">
                      <label className="promoter-label" htmlFor="promo-birth">Fecha de nacimiento *</label>
                      <input
                        id="promo-birth"
                        type="date"
                        className="promoter-input"
                        value={form.customer_birth_date}
                        onChange={(e) => setForm((f) => ({ ...f, customer_birth_date: e.target.value }))}
                      />
                      <span className="promoter-hint">Evento para {event.min_age}+. La edad se valida en la puerta.</span>
                    </div>
                  ) : null}
                  {selectedType?.price_cents > 0 ? (
                    <div className="promoter-field">
                      <span className="promoter-label">¿Cómo se pagó? *</span>
                      <div className="promoter-filter-row" role="radiogroup" aria-label="Método de pago">
                        {[
                          { id: "efectivo", label: "Efectivo" },
                          { id: "transferencia", label: "Transferencia" },
                        ].map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            className="promoter-chip"
                            aria-pressed={form.payment_method === p.id}
                            onClick={() => setForm((f) => ({ ...f, payment_method: p.id }))}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                      <span className="promoter-hint">La venta queda reportada a tu nombre y entra a tus comisiones cuando la organización la confirma.</span>
                    </div>
                  ) : null}
                  {formError && <p className="promoter-error" role="alert">{formError}</p>}
                  <div className="promoter-actions-row">
                    <button type="button" className="promoter-btn" onClick={() => setStep(1)}>Atrás</button>
                    <button type="submit" className="promoter-btn promoter-btn--primary">Revisar</button>
                  </div>
                </form>
              )}

              {step === 3 && (
                <div className="promoter-form">
                  <div className="promoter-summary">
                    <div className="promoter-summary-row"><span>Evento</span><b>{event.name}</b></div>
                    <div className="promoter-summary-row"><span>Tipo</span><b>{selectedType.name}</b></div>
                    <div className="promoter-summary-row"><span>Invitado</span><b>{form.customer_name}</b></div>
                    <div className="promoter-summary-row"><span>Contacto</span><b>{form.customer_phone || form.customer_email}</b></div>
                    <div className="promoter-summary-row"><span>Origen</span><b>{modeLabel(selectedType, mode)}</b></div>
                    <div className="promoter-summary-row promoter-summary-total"><span>Valor</span><b>{priceLabel(selectedType.price_cents)}</b></div>
                  </div>
                  {formError && <p className="promoter-error" role="alert">{formError}</p>}
                  <div className="promoter-actions-row">
                    <button type="button" className="promoter-btn" onClick={() => setStep(2)} disabled={busy}>Atrás</button>
                    <button type="button" className="promoter-btn promoter-btn--primary" onClick={emit} disabled={busy}>
                      {busy ? "Emitiendo…" : "Emitir boleta"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <div className="promoter-page" id="kit">
          <section className="promoter-panel" aria-labelledby="cupo-title">
            <div className="promoter-panel-head">
              <div>
                <h2 className="promoter-panel-title" id="cupo-title">Tu cupo</h2>
                <p className="promoter-panel-hint">{availableSummary(event.ticket_types)}</p>
              </div>
            </div>
            <div className="promoter-type-grid">
              {event.ticket_types.map((t) => (
                <div key={t.id} className="promoter-type-card">
                  <span className="promoter-type-row">
                    <span className="promoter-type-name">{t.name}</span>
                    <span className="promoter-type-price">{priceLabel(t.price_cents)}</span>
                  </span>
                  <span className="promoter-type-meta">
                    {t.is_courtesy && t.my_capacity > 0
                      ? `${t.my_issued} emitidas · ${t.my_remaining} restantes de ${t.my_capacity}`
                      : `${t.available} disponibles en el evento`}
                  </span>
                </div>
              ))}
              {event.ticket_types.length === 0 && <p className="promoter-hint">Sin tipos de boleta todavía.</p>}
            </div>
          </section>

          <section className="promoter-panel" aria-labelledby="kit-title">
            <div className="promoter-panel-head">
              <div>
                <h2 className="promoter-panel-title" id="kit-title">Kit de promoción</h2>
                <p className="promoter-panel-hint">Link propio, texto listo y métricas reales de tu link.</p>
              </div>
            </div>
            {kitError && <PromoterAlert tone="warn">{kitError}</PromoterAlert>}
            {!kit && !kitError && <div className="promoter-skeleton promoter-skeleton--line" />}
            {kit && (
              <>
                <div className="promoter-kit-grid">
                  <span className="promoter-kit-stat"><b>{kit.visits}</b><span>Aperturas</span></span>
                  <span className="promoter-kit-stat"><b>{kit.checkouts}</b><span>Checkouts</span></span>
                  <span className="promoter-kit-stat"><b>{kit.purchases}</b><span>Compras</span></span>
                  <span className="promoter-kit-stat"><b>{money(kit.attributed_revenue_cents)}</b><span>Ventas atribuidas</span></span>
                </div>
                <div className="promoter-link-box">
                  <code>{kit.url}</code>
                  <div className="promoter-actions-row">
                    <button type="button" className="promoter-btn promoter-btn--sm" onClick={() => copy(kit.url, "Link copiado.")}>
                      <Icon name="copy" aria-hidden="true" />
                      Copiar link
                    </button>
                    <button type="button" className="promoter-btn promoter-btn--sm" onClick={() => setShowShare(true)}>
                      <Icon name="whatsapp" aria-hidden="true" />
                      Compartir
                    </button>
                    {event.flyer_url && (
                      <a className="promoter-btn promoter-btn--sm" href={event.flyer_url} download target="_blank" rel="noreferrer">
                        <Icon name="download" aria-hidden="true" />
                        Afiche oficial
                      </a>
                    )}
                  </div>
                </div>
                <label className="promoter-field">
                  <span className="promoter-label">Texto para compartir</span>
                  <textarea
                    className="promoter-input"
                    value={kitText}
                    onChange={(e) => setKitText(e.target.value)}
                  />
                </label>
                <div className="promoter-actions-row">
                  <button type="button" className="promoter-btn promoter-btn--primary" onClick={() => copy(kitText, "Texto copiado.")}>
                    <Icon name="copy" aria-hidden="true" />
                    Copiar texto
                  </button>
                  {waDigits(event.contact_phone) ? (
                    <a
                      className="promoter-btn promoter-btn--ok"
                      href={`https://wa.me/${waDigits(event.contact_phone)}?text=${encodeURIComponent(kitText)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="whatsapp" aria-hidden="true" />
                      WhatsApp
                    </a>
                  ) : null}
                </div>
                <p className="promoter-kit-note">
                  Comisión del link: {kit.commission_pct}% sobre ventas atribuidas.
                  La atribución se guarda aunque el fan pague con Wompi.
                </p>
              </>
            )}
          </section>
        </div>
      </div>

      {showTicket && lastTicket?.raw_token && (
        <PromoterTicketFullscreen ticket={lastTicket} onClose={() => setShowTicket(false)} />
      )}

      {showShare && (
        <PromoterShareSheet
          title={lastTicket?.raw_token ? "Compartir boleta" : "Compartir link"}
          text={lastTicket?.raw_token ? ticketMessage({
            customerName: lastTicket.customer_name,
            eventName: lastTicket.event_name,
            ticketId: lastTicket.ticket_id,
            url: ticketUrl,
          }) : kitText}
          url={lastTicket?.raw_token ? ticketUrl : kit?.url || ""}
          onClose={() => setShowShare(false)}
          onCopy={copy}
        />
      )}
    </div>
  );
}

function PromoterShareSheet({ title, text, url, onClose, onCopy }) {
  const [value, setValue] = useState(text || "");
  const [copied, setCopied] = useState(false);
  const waText = url && !value.includes(url) ? `${value} ${url}` : value;
  return (
    <PromoterDrawer
      title={title}
      subtitle="Revisa el texto antes de enviarlo."
      onClose={onClose}
      footer={(
        <>
          <button
            type="button"
            className="promoter-btn"
            onClick={async () => {
              await onCopy(value, "Texto copiado.");
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
          >
            <Icon name="copy" aria-hidden="true" />
            {copied ? "Copiado" : "Copiar texto"}
          </button>
          <a
            className="promoter-btn promoter-btn--ok"
            href={`https://wa.me/?text=${encodeURIComponent(waText)}`}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="whatsapp" aria-hidden="true" />
            WhatsApp
          </a>
        </>
      )}
    >
      <label className="promoter-field">
        <span className="promoter-label">Mensaje</span>
        <textarea className="promoter-input" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      {url && <div className="promoter-link-box"><code>{url}</code></div>}
    </PromoterDrawer>
  );
}
