import { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  createAccreditation,
  listAccreditations,
  revokeAccreditation,
} from "../lib/api";
import { useDialogA11y } from "../lib/useDialogA11y";
import { useUI } from "../lib/ui";
import Icon from "./Icon";

const CATEGORIES = [
  { id: "prensa", label: "Prensa" },
  { id: "artista", label: "Artista" },
  { id: "produccion", label: "Producción" },
  { id: "patrocinador", label: "Patrocinador" },
  { id: "invitado", label: "Invitado" },
];

function AccreditationQr({ accreditation, onClose }) {
  const { dialogRef, titleId } = useDialogA11y({ onClose });
  const [qr, setQr] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    QRCode.toDataURL(accreditation.raw_token, {
      width: 640,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then(setQr)
      .catch(() => setQr(null));
  }, [accreditation.raw_token]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(accreditation.raw_token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* el token queda visible para copiar a mano */
    }
  }

  return (
    <div className="dialog-backdrop fixed inset-0 z-50 flex items-end justify-center overflow-y-auto p-4 sm:items-center">
      <div
        ref={dialogRef}
        className="dialog-panel my-auto max-w-sm text-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <span className="dialog-grab" aria-hidden="true" />
        <div className="dialog-head">
          <div className="min-w-0 text-left">
            <p id={titleId} className="dialog-title">
              Acreditación · {accreditation.holder_name}
            </p>
            <p className="dialog-sub">
              {accreditation.category}
              {accreditation.zone ? ` · ${accreditation.zone}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose} className="dialog-close" aria-label="Cerrar">
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>
        <div className="dialog-body">
          {qr ? (
            <img
              src={qr}
              alt={`QR de la acreditación de ${accreditation.holder_name}`}
              decoding="async"
              className="mx-auto h-56 w-56 rounded-lg bg-white p-2"
            />
          ) : (
            <div className="skeleton mx-auto h-56 w-56 rounded-lg" />
          )}
          <p className="mt-3 text-2xs leading-relaxed text-zinc-500">
            Este QR sirve para {accreditation.entries_allowed}{" "}
            {accreditation.entries_allowed === 1 ? "ingreso" : "ingresos"}. La
            puerta lo escanea igual que una boleta; no ocupa aforo.
          </p>
        </div>
        <div className="dialog-foot dialog-foot--center">
          <button type="button" onClick={copy} className="btn-ghost text-xs font-bold">
            {copied ? "Token copiado" : "Copiar token"}
          </button>
          <button type="button" onClick={onClose} className="btn-primary text-xs font-bold">
            Listo
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AccreditationsPanel({ venueId, eventId, ev }) {
  const ui = useUI();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [form, setForm] = useState({
    holder_name: "",
    holder_email: "",
    holder_phone: "",
    category: "prensa",
    zone: "",
    valid_from: "",
    valid_until: "",
    entries_allowed: 1,
  });

  async function load() {
    setLoading(true);
    setError("");
    try {
      setItems(await listAccreditations(venueId, eventId));
    } catch (err) {
      setError(err.message || "No pudimos cargar las acreditaciones.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, eventId]);

  function patch(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function create(e) {
    e.preventDefault();
    if (busy) return;
    if (!form.holder_name.trim()) {
      setError("Escribe el nombre del acreditado.");
      return;
    }
    setBusy(true);
    setError("");
    const payload = {
      holder_name: form.holder_name.trim(),
      holder_email: form.holder_email.trim() || null,
      holder_phone: form.holder_phone.trim() || null,
      category: form.category,
      zone: form.zone.trim() || null,
      valid_from: form.valid_from ? new Date(form.valid_from).toISOString() : null,
      valid_until: form.valid_until ? new Date(form.valid_until).toISOString() : null,
      entries_allowed: Number(form.entries_allowed) || 1,
    };
    try {
      const res = await createAccreditation(venueId, eventId, payload);
      setCreated(res);
      setForm({
        holder_name: "",
        holder_email: "",
        holder_phone: "",
        category: "prensa",
        zone: "",
        valid_from: "",
        valid_until: "",
        entries_allowed: 1,
      });
      await load();
    } catch (err) {
      setError(err.message || "No pudimos crear la acreditación.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(item) {
    const ok = await ui.confirm(`¿Revocar la acreditación de ${item.holder_name}?`, {
      body: "Su QR dejará de abrir la puerta en el acto.",
      confirmLabel: "Revocar",
      danger: true,
    });
    if (!ok) return;
    try {
      await revokeAccreditation(venueId, eventId, item.id);
      ui.toast("Acreditación revocada.", "success");
      await load();
    } catch (err) {
      ui.error(err.message || "No pudimos revocar la acreditación.");
    }
  }

  return (
    <div className="admin-panel-card bs-accreditations">
      <div className="bs-box-office-head">
        <div>
          <h2>Acreditaciones de esta noche</h2>
          <p>
            Prensa, artistas, producción y patrocinadores. No consumen aforo ni
            entran en caja; la puerta las escanea con el mismo lector.
          </p>
        </div>
        <span className="bs-status" data-status="live">
          <span className="bs-status-dot" aria-hidden="true" />
          {items.filter((i) => i.status === "active").length} activas
        </span>
      </div>

      <form className="bs-accreditation-form" onSubmit={create}>
        <div className="bs-form-row">
          <label className="bs-field">
            <span>Nombre</span>
            <input
              className="field"
              value={form.holder_name}
              onChange={(e) => patch("holder_name", e.target.value)}
              required
            />
          </label>
          <label className="bs-field">
            <span>Categoría</span>
            <select
              className="field"
              value={form.category}
              onChange={(e) => patch("category", e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="bs-form-row">
          <label className="bs-field">
            <span>Zona autorizada</span>
            <input
              className="field"
              placeholder="Escenario, backstage, prensa…"
              value={form.zone}
              onChange={(e) => patch("zone", e.target.value)}
            />
          </label>
          <label className="bs-field">
            <span>Ingresos permitidos</span>
            <input
              className="field"
              type="number"
              min="1"
              max="50"
              value={form.entries_allowed}
              onChange={(e) => patch("entries_allowed", e.target.value)}
            />
          </label>
        </div>
        <div className="bs-form-row">
          <label className="bs-field">
            <span>Válida desde</span>
            <input
              className="field"
              type="datetime-local"
              value={form.valid_from}
              onChange={(e) => patch("valid_from", e.target.value)}
            />
          </label>
          <label className="bs-field">
            <span>Válida hasta</span>
            <input
              className="field"
              type="datetime-local"
              value={form.valid_until}
              onChange={(e) => patch("valid_until", e.target.value)}
            />
          </label>
        </div>
        <div className="bs-form-row">
          <label className="bs-field">
            <span>Correo (opcional)</span>
            <input
              className="field"
              type="email"
              value={form.holder_email}
              onChange={(e) => patch("holder_email", e.target.value)}
            />
          </label>
          <label className="bs-field">
            <span>Teléfono (opcional)</span>
            <input
              className="field"
              value={form.holder_phone}
              onChange={(e) => patch("holder_phone", e.target.value)}
              inputMode="tel"
            />
          </label>
        </div>
        {error && (
          <p className="admin-note" role="alert" data-tone="warn">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={busy || ev.status === "cancelled"}>
          {busy ? "Creando…" : "Crear acreditación"}
        </button>
      </form>

      {loading ? (
        <p className="admin-note">Cargando acreditaciones…</p>
      ) : items.length === 0 ? (
        <p className="admin-note">
          Aún no hay acreditaciones. Crea la primera para prensa, artistas o
          producción.
        </p>
      ) : (
        <div className="bs-accreditation-list">
          {items.map((item) => (
            <div className="bs-accreditation-row" key={item.id} data-revoked={item.status !== "active"}>
              <div>
                <strong>{item.holder_name}</strong>
                <p>
                  {item.category}
                  {item.zone ? ` · ${item.zone}` : ""} ·{" "}
                  {item.entries_used}/{item.entries_allowed} ingresos
                </p>
              </div>
              <span className="bs-status" data-status={item.status === "active" ? "live" : "cancelled"}>
                <span className="bs-status-dot" aria-hidden="true" />
                {item.status === "active" ? "Activa" : "Revocada"}
              </span>
              {item.status === "active" && (
                <button type="button" className="bs-secondary" onClick={() => revoke(item)}>
                  Revocar
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {created && <AccreditationQr accreditation={created} onClose={() => setCreated(null)} />}
    </div>
  );
}
