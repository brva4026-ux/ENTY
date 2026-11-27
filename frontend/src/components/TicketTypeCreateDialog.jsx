import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../lib/api";
import { useDialogA11y } from "../lib/useDialogA11y";
import Icon from "./Icon";

const OPTIONS = [
  { id: "general", label: "General", icon: "ticket", hint: "Entrada estándar" },
  { id: "vip", label: "VIP", icon: "bolt", hint: "Acceso preferencial" },
  { id: "courtesy", label: "Cortesía", icon: "check", hint: "Entrada sin cobro" },
  { id: "sector", label: "Sector personalizado", icon: "pin", hint: "Por ejemplo, Terraza" },
];

export default function TicketTypeCreateDialog({ venueId, eventId, suggestedQuantity, onCreated, onClose }) {
  const [option, setOption] = useState(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState(suggestedQuantity ? String(suggestedQuantity) : "");
  const [virtual, setVirtual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const nameRef = useRef(null);
  const courtesy = option?.id === "courtesy";
  const action = courtesy ? "Crear cortesía" : option?.id === "sector" ? "Crear sector" : "Crear tipo de boleta";
  const close = () => { if (!pending.current) onClose(); };
  const { dialogRef, titleId } = useDialogA11y({ onClose: close });

  function choose(next) {
    if (next.id === option?.id) return;
    setOption(next);
    setName(next.id === "sector" ? "" : next.label);
    setError("");
    requestAnimationFrame(() => nameRef.current?.focus());
  }

  async function submit(e) {
    e.preventDefault();
    if (!option || pending.current) return;
    if (!name.trim()) {
      setError("Escribe un nombre para este tipo de boleta.");
      nameRef.current?.focus();
      return;
    }
    const priceCents = courtesy ? 0 : Math.round(Number(price) * 100);
    if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
      setError("Escribe un precio válido en pesos.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const created = await apiFetch(`/venues/${venueId}/events/${eventId}/types`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          price_cents: priceCents,
          quantity: Number(qty),
          is_courtesy: courtesy,
          is_virtual: virtual,
        }),
      });
      onCreated(created);
    } catch (error) {
      setError(error.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return createPortal(
    <div className="dialog-backdrop ticket-create-backdrop" onClick={(e) => {
      if (e.target === e.currentTarget) close();
    }}>
      <section ref={dialogRef} className="dialog-panel ticket-create-panel" role="dialog"
        aria-modal="true" aria-labelledby={titleId}>
        <header className="dialog-head">
          <div>
            <h2 className="dialog-title" id={titleId}>Nuevo tipo de boleta</h2>
            <p className="dialog-sub">Elige qué entrada vas a ofrecer en este evento.</p>
          </div>
          <button type="button" className="dialog-close" aria-label="Cerrar" onClick={close} disabled={busy}>
            <Icon name="close" className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="dialog-body">
            <div className="ticket-create-options" role="group" aria-label="Tipo de entrada">
              {OPTIONS.map((item, index) => (
                <button key={item.id} type="button" aria-pressed={option?.id === item.id}
                  disabled={busy} onClick={() => choose(item)} data-dialog-autofocus={index === 0 ? true : undefined}>
                  <Icon name={item.icon} aria-hidden="true" />
                  <span><strong>{item.label}</strong><small>{item.hint}</small></span>
                </button>
              ))}
            </div>
            {option && (
              <fieldset className="ticket-create-fields" disabled={busy}>
                <label className="ticket-create-name">
                  {option.id === "sector" ? "Nombre del sector" : "Nombre en la boleta"}
                  <input ref={nameRef} className="field" value={name} onChange={(e) => setName(e.target.value)}
                    placeholder={option.id === "sector" ? "Terraza, balcón…" : undefined} maxLength={60} required />
                </label>
                <label>
                  Cupo de boletas
                  <input className="field" type="number" inputMode="numeric" min="1" step="1"
                    value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Ej. 50" required />
                </label>
                {courtesy ? (
                  <div className="ticket-create-free"><span>Precio</span><strong>$0 · Cortesía</strong></div>
                ) : (
                  <label>
                    Precio en pesos (COP)
                    <input className="field" type="number" inputMode="decimal" min="0" step="0.01"
                      value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Ej. 50000" required />
                  </label>
                )}
                <details className="ticket-create-advanced admin-task-details">
                  <summary>Opciones adicionales</summary>
                  <label><input type="checkbox" checked={virtual} onChange={(e) => setVirtual(e.target.checked)} /> Boleta virtual</label>
                </details>
              </fieldset>
            )}
            {error && <p role="alert" className="ticket-create-error">{error}</p>}
          </div>
          <footer className="ticket-create-footer">
            <button type="button" className="btn-ghost" onClick={close} disabled={busy}>Cancelar</button>
            <button type="submit" className="btn-primary" disabled={!option || busy}>
              {busy ? "Creando…" : action}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  );
}
