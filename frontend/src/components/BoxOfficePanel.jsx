import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, fetchTicketByRequest } from "../lib/api";
import { money, plural } from "../lib/format";
import { useUI } from "../lib/ui";
import TicketQrModal from "./TicketQrModal";

const PAYMENT_METHODS = [
  { id: "efectivo", label: "Efectivo" },
  { id: "transferencia", label: "Transferencia" },
];

const METHOD_LABEL = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  online: "Pago en línea",
  cortesia: "Cortesía",
};

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `pos-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function SellerReconciliation({ bySeller }) {
  const sellers = useMemo(() => {
    const map = new Map();
    for (const row of bySeller || []) {
      const key = row.seller_id ?? "unknown";
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          name: row.full_name,
          total: 0,
          tickets: 0,
          methods: [],
        });
      }
      const seller = map.get(key);
      seller.total += row.revenue_cents ?? 0;
      seller.tickets += row.tickets ?? 0;
      seller.methods.push(row);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [bySeller]);

  if (!sellers.length) {
    return (
      <p className="admin-note">
        Todavía no hay ventas de taquilla con medio de pago registrado. Las
        boletas de cortesía no entran en el arqueo.
      </p>
    );
  }

  return (
    <div className="bs-seller-grid">
      {sellers.map((seller) => (
        <div className="bs-seller-card" key={seller.id}>
          <div className="bs-seller-head">
            <strong>{seller.name}</strong>
            <span className="tnum">{money(seller.total)}</span>
          </div>
          <p className="admin-note">
            {seller.tickets} {plural(seller.tickets, "boleta pagada", "boletas pagadas")}
          </p>
          <ul className="bs-seller-methods">
            {seller.methods.map((m) => (
              <li key={`${seller.id}-${m.payment_method ?? "sin"}`}>
                <span>{METHOD_LABEL[m.payment_method] ?? "Sin medio"}</span>
                <b className="tnum">{money(m.revenue_cents)}</b>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function BoxOfficePanel({
  ev,
  report,
  types = [],
  venueId,
  eventId,
  onChanged,
}) {
  const ui = useUI();
  const activeTypes = useMemo(
    () => (types || []).filter((t) => t.is_active !== false),
    [types],
  );
  const issuedByType = useMemo(() => {
    const map = new Map();
    for (const row of report?.by_type || []) {
      map.set(row.ticket_type_id, row.issued ?? 0);
    }
    return map;
  }, [report]);

  const [typeId, setTypeId] = useState(activeTypes[0]?.id ?? null);
  const [form, setForm] = useState({
    customer_name: "",
    customer_phone: "",
    customer_email: "",
    customer_birth_date: "",
    payment_method: "efectivo",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastTicket, setLastTicket] = useState(null);
  const [displayOpen, setDisplayOpen] = useState(false);
  const requestRef = useRef("");
  const channelRef = useRef(null);

  useEffect(() => {
    if (!eventId || typeof BroadcastChannel === "undefined") return undefined;
    const channel = new BroadcastChannel(`tf_pos_${eventId}`);
    channelRef.current = channel;
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [eventId]);

  function publishOrder(status = "ready") {
    if (!displayOpen) return;
    const payload = {
      eventName: ev?.name ?? "",
      typeName: selectedType?.name ?? "Elige una localidad",
      priceCents: selectedType?.price_cents ?? 0,
      paymentMethod: paid ? form.payment_method : "",
      status,
      updatedAt: Date.now(),
    };
    try {
      localStorage.setItem(`tf_pos_display_${eventId}`, JSON.stringify(payload));
    } catch {
      /* almacenamiento privado */
    }
    channelRef.current?.postMessage(payload);
  }

  useEffect(() => {
    if (!displayOpen) return;
    publishOrder("ready");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayOpen, typeId, form.payment_method]);

  function openDisplay() {
    const win = window.open(
      `/taquilla/pantalla?evento=${eventId}`,
      "enty-pos-display",
      "width=1000,height=720",
    );
    setDisplayOpen(Boolean(win));
    if (!win) {
      ui.toast("El navegador bloqueó la segunda pantalla. Permite ventanas emergentes.", "error");
    }
  }

  const selectedType = activeTypes.find((t) => t.id === typeId) || null;
  const paid = selectedType && selectedType.price_cents > 0;

  function patch(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function validate() {
    if (!selectedType) return "Elige una localidad.";
    if (!form.customer_name.trim()) return "Escribe el nombre del comprador.";
    if (!form.customer_phone.trim()) return "Escribe el teléfono del comprador.";
    if (form.customer_phone.replace(/\D/g, "").length < 10) {
      return "El teléfono debe incluir el indicativo (mínimo 10 dígitos).";
    }
    if (paid && !form.payment_method) return "Elige cómo se pagó.";
    if (ev.min_age && !form.customer_birth_date) {
      return `Este evento es para ${ev.min_age}+: registra la fecha de nacimiento.`;
    }
    return "";
  }

  async function emit() {
    if (busy) return;
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    if (!requestRef.current) requestRef.current = uid();
    const requestId = requestRef.current;
    setBusy(true);
    setError("");
    const payload = {
      ticket_type_id: selectedType.id,
      customer_name: form.customer_name.trim(),
      customer_phone: form.customer_phone.trim(),
      customer_email: form.customer_email.trim() || null,
      customer_birth_date: form.customer_birth_date || null,
      payment_method: paid ? form.payment_method : null,
      client_request_id: requestId,
    };
    try {
      const res = await apiFetch(`/venues/${venueId}/events/${eventId}/tickets`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      complete(res, payload);
    } catch (err) {
      if (err.status && err.status < 500) {
        setError(err.message || "No pudimos emitir la boleta.");
        return;
      }
      setError("No recibimos la confirmación. Verificando si la boleta quedó emitida…");
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700 + i * 400));
        try {
          const found = await fetchTicketByRequest(venueId, eventId, requestId);
          complete(found, payload, true);
          return;
        } catch {
          /* reintento */
        }
      }
      setError(err.message || "No pudimos emitir la boleta.");
    } finally {
      setBusy(false);
    }
  }

  function complete(res, payload, recovered = false) {
    setLastTicket({
      id: res.ticket_id,
      raw_token: res.raw_token,
      customer_name: payload.customer_name,
      customer_phone: payload.customer_phone,
      type_name: selectedType?.name,
      event_name: ev.name,
      duplicate: res.duplicate || recovered,
    });
    requestRef.current = "";
    setForm({
      customer_name: "",
      customer_phone: "",
      customer_email: "",
      customer_birth_date: "",
      payment_method: "efectivo",
    });
    publishOrder("paid");
    ui.toast("Boleta emitida. Entrega el QR o el enlace.", "success");
    onChanged?.();
  }

  return (
    <div className="admin-panel-card bs-box-office">
      <div className="bs-box-office-head">
        <div>
          <h2>Taquilla de esta noche</h2>
          <p>
            Vende en el lugar contra el mismo inventario de la venta digital.
            Cada boleta queda a nombre de quien la emite para cerrar su caja.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost !px-3 !py-1.5 text-2xs" onClick={openDisplay}>
            Abrir pantalla cliente
          </button>
          <span className="bs-status" data-status={ev.status === "live" ? "live" : "published"}>
            <span className="bs-status-dot" aria-hidden="true" />
            {ev.status === "live" ? "Puerta abierta" : "Venta directa"}
          </span>
        </div>
      </div>

      <div className="bs-box-office-grid">
        <div className="bs-box-office-form">
          <label className="bs-field">
            <span>Localidad</span>
            <select
              className="field"
              value={typeId ?? ""}
              onChange={(e) => setTypeId(Number(e.target.value))}
            >
              {activeTypes.map((t) => {
                const issued = issuedByType.get(t.id) ?? 0;
                const left = Math.max(0, (t.quantity ?? 0) - issued);
                return (
                  <option key={t.id} value={t.id}>
                    {t.name} · {money(t.price_cents)} · {left} disponibles
                  </option>
                );
              })}
            </select>
          </label>
          {!activeTypes.length && (
            <p className="admin-note" role="alert">
              No hay localidades activas. Crea una en Ventas antes de abrir taquilla.
            </p>
          )}

          <div className="bs-form-row">
            <label className="bs-field">
              <span>Nombre del comprador</span>
              <input
                className="field"
                value={form.customer_name}
                onChange={(e) => patch("customer_name", e.target.value)}
                autoComplete="name"
              />
            </label>
            <label className="bs-field">
              <span>Teléfono</span>
              <input
                className="field"
                value={form.customer_phone}
                onChange={(e) => patch("customer_phone", e.target.value)}
                inputMode="tel"
                autoComplete="tel"
              />
            </label>
          </div>

          <div className="bs-form-row">
            <label className="bs-field">
              <span>Correo (opcional)</span>
              <input
                className="field"
                type="email"
                value={form.customer_email}
                onChange={(e) => patch("customer_email", e.target.value)}
                autoComplete="email"
              />
            </label>
            {ev.min_age ? (
              <label className="bs-field">
                <span>Fecha de nacimiento ({ev.min_age}+)</span>
                <input
                  className="field"
                  type="date"
                  value={form.customer_birth_date}
                  onChange={(e) => patch("customer_birth_date", e.target.value)}
                />
              </label>
            ) : null}
          </div>

          {paid && (
            <div className="bs-pay-methods" role="group" aria-label="Medio de pago">
              {PAYMENT_METHODS.map((method) => (
                <button
                  key={method.id}
                  type="button"
                  className="bs-pay-method"
                  aria-pressed={form.payment_method === method.id}
                  onClick={() => patch("payment_method", method.id)}
                >
                  {method.label}
                </button>
              ))}
            </div>
          )}

          {error && (
            <p className="admin-note" role="alert" data-tone="warn">
              {error}
            </p>
          )}

          <button
            type="button"
            className="btn-primary w-full"
            onClick={emit}
            disabled={busy || !selectedType}
          >
            {busy ? "Emitiendo…" : `Cobrar ${selectedType ? money(selectedType.price_cents) : ""}`}
          </button>
        </div>

        <div className="bs-box-office-cash">
          <h3>Arqueo por cajero</h3>
          <p className="admin-note">
            Lo que cada persona debería tener en su cajón. Las transferencias se
            concilian aparte.
          </p>
          <SellerReconciliation bySeller={report?.by_seller} />
        </div>
      </div>

      {lastTicket && (
        <TicketQrModal ticket={lastTicket} onClose={() => setLastTicket(null)} />
      )}
    </div>
  );
}
