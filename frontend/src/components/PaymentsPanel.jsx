import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { money } from "../lib/format";
import { haptics } from "../lib/haptics";
import { paymentWaMessage, waLink } from "../lib/whatsapp";
import Icon from "./Icon";

/**
 * Cobros online (E3, Wompi): el bar cobra una boleta por enlace de pago.
 *
 * El admin elige evento + tipo, pone el contacto del comprador y el monto
 * negociado; la app crea el cobro en Wompi y devuelve la URL para mandarla
 * por WhatsApp. La boleta se emite SOLA cuando el webhook de Wompi aprueba
 * el pago: aqui solo se crea el cobro, nunca el QR (el dinero entra primero).
 */

const PAY_STATUS = {
  paid_unfulfilled: {
    label: "Pagado: revisar entrada o reembolso",
    cls: "bg-red-950/80 text-red-400 ring-red-500/30",
  },
  pending: {
    label: "Pendiente",
    cls: "bg-amber-950/80 text-amber-400 ring-amber-500/30",
  },
  approved: {
    label: "Pagado",
    cls: "bg-emerald-950/80 text-emerald-400 ring-emerald-500/30",
  },
  declined: {
    label: "Rechazado",
    cls: "bg-red-950/80 text-red-400 ring-red-500/30",
  },
  voided: { label: "Anulado", cls: "bg-zinc-800 text-zinc-400 ring-zinc-700" },
  expired: { label: "Expirado", cls: "bg-zinc-800 text-zinc-500 ring-zinc-700" },
};

const EMPTY_FORM = {
  ticket_type_id: "",
  amount: "",
  customer_name: "",
  customer_phone: "",
  customer_email: "",
};

export default function PaymentsPanel({ venueId, events = [] }) {
  const [eventId, setEventId] = useState("");
  const [types, setTypes] = useState([]);
  const [payments, setPayments] = useState(null); // null = primera carga
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Último cobro creado: su URL es lo único que el admin necesita AHORA
  // (mandarla). Se guarda con el contacto para armar el wa.me directo.
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);

  const activeTypes = types.filter((t) => t.is_active);
  const event = events.find((e) => String(e.id) === String(eventId));

  const loadPayments = useCallback(async () => {
    if (!eventId) return;
    setPayments(null);
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${eventId}/payments`,
      );
      setPayments(data);
    } catch (err) {
      setError(err.message);
      setPayments({ total: 0, items: [] });
    }
  }, [venueId, eventId]);

  // Al cambiar de evento: tipos de boleta del evento + cobros existentes.
  useEffect(() => {
    if (!eventId) return;
    setTypes([]);
    setForm((f) => ({ ...f, ticket_type_id: "" }));
    setCreated(null);
    apiFetch(`/venues/${venueId}/events/${eventId}/types`)
      .then(setTypes)
      .catch(() => setTypes([]));
    loadPayments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, venueId]);

  async function submit(e) {
    e.preventDefault();
    const cents = Math.round(Number(form.amount) * 100);
    if (!form.ticket_type_id) {
      setError("Elige el tipo de boleta a cobrar.");
      return;
    }
    if (!Number.isInteger(cents) || cents <= 0) {
      setError("Escribe un monto válido mayor que cero.");
      return;
    }
    if (!form.customer_name.trim() || form.customer_phone.trim().length < 5) {
      setError("Necesitas nombre y teléfono del comprador.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const out = await apiFetch(
        `/venues/${venueId}/events/${eventId}/payments`,
        {
          method: "POST",
          body: JSON.stringify({
            ticket_type_id: Number(form.ticket_type_id),
            amount_in_cents: cents,
            customer_name: form.customer_name.trim(),
            customer_phone: form.customer_phone.trim(),
            customer_email: form.customer_email.trim() || null,
          }),
        },
      );
      // El contacto viaja junto para el botón de WhatsApp del bloque de éxito.
      setCreated({
        ...out,
        customer_name: form.customer_name.trim(),
        customer_phone: form.customer_phone.trim(),
        event_name: event?.name,
      });
      setForm(EMPTY_FORM);
      haptics.tick();
      await loadPayments();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(created.payment_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard bloqueado: el enlace también es clicable en el bloque.
    }
  }

  // Enlace de entrega del cobro recién creado (helper compartido; si el
  // teléfono no da para wa.me, el botón no se pinta en lugar de abrir un
  // chat con número truncado).
  const waHref = created
    ? waLink(
        created.customer_phone,
        paymentWaMessage({
          customerName: created.customer_name,
          amountLabel: money(created.amount_in_cents),
          url: created.payment_url,
        }),
      )
    : null;

  if (events.length === 0) {
    return (
      <div className="card p-6 text-center text-sm text-zinc-400">
        Crea un evento con tipos de boleta para poder cobrar online.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Selector de evento: el cobro siempre pertenece a una noche. */}
      <div className="card p-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-400">
            Evento
          </span>
          <select
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            className="field"
          >
            <option value="">Elige el evento…</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Sin evento elegido aún: en vez de un vacío mudo, guiar a la acción
          (la misma gramática de EmptyState en el resto de la app). */}
      {!eventId && (
        <div className="card p-6 text-center">
          <p className="display text-base">Elige un evento para ver sus cobros</p>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-zinc-400">
            Arriba está el listado de eventos; al elegir uno ves los cobros que
            ya tiene y puedes crear el enlace de pago del siguiente.
          </p>
        </div>
      )}

      {eventId && (
        <>
          {/* Resultado del cobro recién creado: la acción es mandar el enlace. */}
          {created && (
            <div className="card border-emerald-900/60 p-4">
              <p className="display mb-1 text-base">Cobro creado</p>
              <p className="mb-3 text-xs leading-relaxed text-zinc-400">
                Envíale este enlace a {created.customer_name}. Cuando pague, la
                boleta se emite sola y aparece con estado{" "}
                <span className="font-semibold text-emerald-300">Pagado</span>.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {waHref && (
                  <a
                    href={waHref}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-primary !px-3 !py-1.5 text-xs"
                  >
                    <Icon name="whatsapp" className="h-4 w-4" />
                    Enviar por WhatsApp
                  </a>
                )}
                <button
                  onClick={copyUrl}
                  className="btn-ghost !px-3 !py-1.5 text-xs font-bold"
                >
                  <Icon name="copy" className="h-3.5 w-3.5" />
                  {copied ? "¡Copiado!" : "Copiar enlace"}
                </button>
                <a
                  href={created.payment_url}
                  target="_blank"
                  rel="noreferrer"
                  className="link-underline text-xs text-zinc-400"
                >
                  Abrir enlace
                </a>
              </div>
            </div>
          )}

          {/* Formulario de cobro */}
          <form onSubmit={submit} className="card p-4">
            <p className="display mb-3 text-base">Cobrar una boleta</p>

            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Tipo de boleta *
                </span>
                <select
                  value={form.ticket_type_id}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, ticket_type_id: e.target.value }))
                  }
                  className="field"
                  required
                >
                  <option value="">Elige el tipo…</option>
                  {activeTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.price_cents > 0
                        ? ` · $${(t.price_cents / 100).toLocaleString("es-CO")}`
                        : " · cortesía"}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Monto a cobrar (COP) *
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={form.amount}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, amount: e.target.value }))
                  }
                  className="field"
                  placeholder="50000"
                  required
                />
              </label>

              <label>
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Nombre del comprador *
                </span>
                <input
                  value={form.customer_name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, customer_name: e.target.value }))
                  }
                  className="field"
                  maxLength={200}
                  placeholder="Ana Gómez"
                  required
                />
              </label>

              <label>
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Teléfono (WhatsApp) *
                </span>
                <input
                  value={form.customer_phone}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, customer_phone: e.target.value }))
                  }
                  className="field"
                  maxLength={30}
                  placeholder="573001234567"
                  required
                />
              </label>

              <label className="sm:col-span-full">
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Correo (opcional)
                </span>
                <input
                  type="email"
                  value={form.customer_email}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, customer_email: e.target.value }))
                  }
                  className="field"
                  maxLength={200}
                  placeholder="ana@correo.com"
                />
              </label>
            </div>

            {error && (
              <p role="alert" className="mt-3 text-xs text-red-400">
                {error}
              </p>
            )}

            <div className="mt-4">
              <button className="btn-primary" disabled={busy}>
                {busy && (
                  <svg
                    className="btn-spinner"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="9" />
                  </svg>
                )}
                {busy ? "Creando cobro" : "Crear enlace de pago"}
              </button>
            </div>
          </form>

          {/* Cobros del evento: estado y boleta emitida, del más nuevo abajo
              de la creación (el listado va del más nuevo al más viejo). */}
          {payments === null ? (
            <div className="card p-4 text-sm text-zinc-500">Cargando…</div>
          ) : payments.total === 0 ? (
            <div className="card p-4 text-sm text-zinc-500">
              Aún no hay cobros para este evento.
            </div>
          ) : (
            <div className="card p-4">
              <p className="display mb-3 text-base">
                Cobros del evento{" "}
                <span className="tnum text-xs font-normal text-zinc-500">
                  {payments.total}
                </span>
              </p>
              <ul className="divide-y divide-zinc-800/80">
                {payments.items.map((p) => {
                  const st = PAY_STATUS[p.status] ?? PAY_STATUS.pending;
                  return (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-zinc-200">
                          {p.customer_name}{" "}
                          <span className="text-xs font-normal text-zinc-500">
                            {p.customer_phone}
                          </span>
                        </p>
                        <p className="tnum text-2xs text-zinc-500">
                          {p.reference}
                          {p.ticket_id ? ` · boleta #${p.ticket_id}` : ""}
                        </p>
                      </div>
                      <span className="tnum font-semibold text-zinc-100">
                        {money(p.amount_in_cents)}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-2xs font-bold uppercase ring-1 ${st.cls}`}
                      >
                        {st.label}
                      </span>
                      {p.status === "pending" && p.payment_url && (
                        (() => {
                          const href = waLink(
                            p.customer_phone,
                            paymentWaMessage({
                              customerName: p.customer_name,
                              amountLabel: money(p.amount_in_cents),
                              url: p.payment_url,
                            }),
                          );
                          return (
                            href && (
                              <a
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-2xs font-bold text-emerald-300 transition hover:bg-emerald-500/10"
                              >
                                <Icon name="whatsapp" className="h-3.5 w-3.5" />
                                Reenviar
                              </a>
                            )
                          );
                        })()
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
