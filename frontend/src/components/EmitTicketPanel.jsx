import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { haptics } from "../lib/haptics";
import { money } from "../lib/format";
import Icon from "./Icon";

/**
 * Venta directa del bar: emite una boleta desde el panel del admin (taquilla
 * o puerta), sin cupo de promotor.
 *
 * El backend ya aceptaba `admin` en POST .../tickets desde el Sprint 1, pero
 * ningun componente del frontend lo llamaba: la taquilla solo existia por
 * curl. Esta es la pantalla que faltaba.
 */
export default function EmitTicketPanel({
  venueId,
  eventId,
  event,
  types,
  onIssued,
  onError,
}) {
  const [form, setForm] = useState({
    ticket_type_id: "",
    customer_name: "",
    customer_phone: "",
    customer_email: "",
  });
  const [busy, setBusy] = useState(false);

  // La emision solo procede con el evento abierto: el backend responde 409 en
  // draft/ended/cancelled (`event_not_open_for_sales`). Se avisa ANTES en vez
  // de dejar que el admin llene el formulario para recibir un error.
  const open = event?.status === "published" || event?.status === "live";

  useEffect(() => {
    setForm((f) => ({ ...f, ticket_type_id: types?.[0]?.id ?? "" }));
  }, [types]);

  const selectedType = (types || []).find(
    (t) => t.id === Number(form.ticket_type_id),
  );

  async function emit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      // Venta directa: SIN `allocation_id`. Una boleta de pago contra cupo de
      // promotor la rechaza el SQL (400); el bar emite a su propio nombre.
      const ticket = await apiFetch(
        `/venues/${venueId}/events/${eventId}/tickets`,
        {
          method: "POST",
          body: JSON.stringify({
            ticket_type_id: Number(form.ticket_type_id),
            customer_name: form.customer_name,
            customer_phone: form.customer_phone,
            customer_email: form.customer_email || null,
          }),
        },
      );
      // La respuesta no trae nombre/telefono: se conservan para armar el wa.me.
      onIssued({
        ...ticket,
        customerName: form.customer_name,
        customerPhone: form.customer_phone,
      });
      haptics.success();
      setForm((f) => ({
        ...f,
        customer_name: "",
        customer_phone: "",
        customer_email: "",
      }));
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card h-fit p-5">
      <p className="eyebrow">Taquilla</p>
      <h3 className="display mb-1 mt-0.5 flex items-center gap-2 text-base">
        <Icon name="plus" className="h-4 w-4 text-brand-400" />
        Emitir boleta
      </h3>
      <p className="mb-4 text-xs text-zinc-500">
        Venta directa en puerta o taquilla. No consume cupo de promotor.
      </p>

      {!open ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-xs text-amber-300 ring-1 ring-amber-500/30">
          Este evento está{" "}
          {event?.status === "draft" ? "en borrador" : "cerrado"}: publícalo
          para poder emitir boletas.
        </p>
      ) : (types || []).length === 0 ? (
        <p className="rounded-lg bg-zinc-800/40 px-3 py-2.5 text-xs text-zinc-500">
          Crea al menos un tipo de boleta en «Entradas» antes de emitir.
        </p>
      ) : (
        <form onSubmit={emit} className="space-y-3.5">
          <div>
            <label
              htmlFor="emit-type"
              className="mb-1 block text-xs font-medium text-zinc-400"
            >
              Tipo de boleta
            </label>
            <select
              id="emit-type"
              value={form.ticket_type_id}
              onChange={(e) => setForm({ ...form, ticket_type_id: e.target.value })}
              className="field"
              required
            >
              {(types || []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} {t.price_cents > 0 ? money(t.price_cents) : "(cortesía)"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="emit-name"
              className="mb-1 block text-xs font-medium text-zinc-400"
            >
              Nombre del asistente *
            </label>
            <input
              id="emit-name"
              value={form.customer_name}
              onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
              className="field"
              placeholder="Nombre y apellido"
              required
            />
          </div>
          <div>
            <label
              htmlFor="emit-phone"
              className="mb-1 block text-xs font-medium text-zinc-400"
            >
              Teléfono *
            </label>
            <input
              id="emit-phone"
              value={form.customer_phone}
              onChange={(e) => setForm({ ...form, customer_phone: e.target.value })}
              className="field"
              placeholder="573001234567"
              inputMode="tel"
              required
            />
          </div>
          <div>
            <label
              htmlFor="emit-email"
              className="mb-1 block text-xs font-medium text-zinc-400"
            >
              Correo (opcional)
            </label>
            <input
              id="emit-email"
              value={form.customer_email}
              onChange={(e) => setForm({ ...form, customer_email: e.target.value })}
              className="field"
              type="email"
              placeholder="asistente@correo.com"
            />
          </div>

          {selectedType?.is_courtesy && (
            <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300 ring-1 ring-emerald-500/30">
              Cortesía: se emite sin costo. Queda registrada como venta directa
              del bar.
            </p>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? "Emitiendo…" : "Emitir boleta"}
          </button>
        </form>
      )}
    </div>
  );
}
