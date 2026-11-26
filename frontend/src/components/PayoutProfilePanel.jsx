import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useUI } from "../lib/ui";

const STATUS = {
  not_started: {
    label: "Sin iniciar",
    tone: "border-slate-600 bg-slate-900/40 text-slate-200",
    help: "Completa estos datos para que Enty revise quién cobra y a dónde llega el dinero.",
  },
  pending: {
    label: "En revisión",
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    help: "Enty está revisando la información. Puedes seguir creando y publicando eventos; solo la venta en línea queda en espera.",
  },
  approved: {
    label: "Aprobado para cobrar",
    tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    help: "Ya puedes vender en línea. Si cambias la cuenta de destino, la revisión se repite.",
  },
  rejected: {
    label: "Rechazado",
    tone: "border-rose-500/40 bg-rose-500/10 text-rose-200",
    help: "Revisa la nota de Enty, corrige lo que falta y envía de nuevo.",
  },
};

const EMPTY = {
  legal_name: "",
  tax_id: "",
  contact_name: "",
  contact_phone: "",
  contact_email: "",
  bank_name: "",
  bank_account_type: "ahorros",
  bank_account_last4: "",
  payout_provider: "",
  payout_account_ref: "",
};

export default function PayoutProfilePanel({ venueId }) {
  const { user } = useAuth();
  const ui = useUI();
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const roles = user?.roles?.[venueId] || [];
  const canReview = roles.includes("super_admin");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch(`/venues/${venueId}/payout-profile`);
      setProfile(data);
      setForm({
        legal_name: data.legal_name || "",
        tax_id: data.tax_id || "",
        contact_name: data.contact_name || "",
        contact_phone: data.contact_phone || "",
        contact_email: data.contact_email || "",
        bank_name: data.bank_name || "",
        bank_account_type: data.bank_account_type || "ahorros",
        bank_account_last4: data.bank_account_last4 || "",
        payout_provider: data.payout_provider || "",
        payout_account_ref: data.payout_account_ref || "",
      });
    } catch (error) {
      ui.error(error.message);
    } finally {
      setLoading(false);
    }
  }, [venueId, ui]);

  useEffect(() => {
    if (venueId) load();
  }, [venueId, load]);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    try {
      await apiFetch(`/venues/${venueId}/payout-profile`, {
        method: "PUT",
        body: JSON.stringify(form),
      });
      await load();
      ui.success("Datos de cobro guardados");
    } catch (error) {
      ui.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    setSaving(true);
    try {
      await apiFetch(`/venues/${venueId}/payout-profile/submit`, { method: "POST" });
      await load();
      ui.success("Solicitud enviada a revisión");
    } catch (error) {
      ui.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function review(status) {
    setSaving(true);
    try {
      await apiFetch(`/venues/${venueId}/payout-profile/review`, {
        method: "POST",
        body: JSON.stringify({ status, note: reviewNote }),
      });
      await load();
      ui.success(status === "approved" ? "Cobros aprobados" : "Solicitud rechazada");
    } catch (error) {
      ui.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-slate-400">Cargando datos de cobro…</p>;

  const status = STATUS[profile?.status] || STATUS.not_started;
  const missing = profile?.missing_items || [];

  return (
    <div className="space-y-4">
      <section className={`admin-panel-card border ${status.tone}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest opacity-80">
              Cobros en línea
            </p>
            <h2 className="mt-1">{status.label}</h2>
            <p className="mt-1 max-w-2xl text-sm opacity-90">{status.help}</p>
          </div>
          <span className="rounded-full border border-current px-3 py-1 text-xs font-semibold">
            {profile?.can_sell_online ? "Venta habilitada" : "Venta en línea bloqueada"}
          </span>
        </div>
        {missing.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-sm font-semibold text-amber-100">Falta completar:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-100/90">
              {missing.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        )}
        {profile?.review_note && (
          <p className="mt-3 text-sm text-slate-200">
            <strong>Nota de Enty:</strong> {profile.review_note}
          </p>
        )}
      </section>

      <section className="admin-panel-card">
        <h2>Responsable y cuenta de destino</h2>
        <p>
          Enty revisa estos datos antes de habilitar la venta en línea. Un
          evento en borrador no se ve afectado.
        </p>
        <form className="admin-settings-grid mt-4" onSubmit={save}>
          <label className="is-full">
            Razón social o nombre del responsable
            <input className="field" value={form.legal_name}
              onChange={(e) => update("legal_name", e.target.value)} maxLength={200} />
          </label>
          <label>
            Documento fiscal
            <input className="field" value={form.tax_id}
              onChange={(e) => update("tax_id", e.target.value)} maxLength={60} />
          </label>
          <label>
            Persona de contacto
            <input className="field" value={form.contact_name}
              onChange={(e) => update("contact_name", e.target.value)} maxLength={120} />
          </label>
          <label>
            Teléfono de contacto
            <input className="field" type="tel" value={form.contact_phone}
              onChange={(e) => update("contact_phone", e.target.value)} maxLength={40} />
          </label>
          <label>
            Correo de contacto
            <input className="field" type="email" value={form.contact_email}
              onChange={(e) => update("contact_email", e.target.value)} maxLength={254} />
          </label>
          <label>
            Banco o billetera
            <input className="field" value={form.bank_name}
              onChange={(e) => update("bank_name", e.target.value)} maxLength={120} />
          </label>
          <label>
            Tipo de cuenta
            <select className="field" value={form.bank_account_type}
              onChange={(e) => update("bank_account_type", e.target.value)}>
              <option value="ahorros">Ahorros</option>
              <option value="corriente">Corriente</option>
              <option value="billetera">Billetera</option>
            </select>
          </label>
          <label>
            Últimos 4 dígitos de la cuenta
            <input className="field" value={form.bank_account_last4}
              onChange={(e) => update("bank_account_last4", e.target.value.replace(/\D/g, "").slice(0, 4))}
              inputMode="numeric" maxLength={4} />
          </label>
          <label>
            Proveedor de pagos (opcional)
            <input className="field" value={form.payout_provider}
              onChange={(e) => update("payout_provider", e.target.value)} maxLength={80} />
          </label>
          <label>
            Referencia de la cuenta en el proveedor (opcional)
            <input className="field" value={form.payout_account_ref}
              onChange={(e) => update("payout_account_ref", e.target.value)} maxLength={200} />
          </label>
          <div className="is-full flex flex-wrap gap-2">
            <button className="btn-mini" type="submit" disabled={saving}>
              {saving ? "Guardando…" : "Guardar datos"}
            </button>
            <button className="btn-mini" type="button" onClick={submit} disabled={saving}>
              Enviar a revisión
            </button>
          </div>
        </form>
      </section>

      {canReview && profile?.status === "pending" && (
        <section className="admin-panel-card">
          <h2>Revisión de Enty</h2>
          <p>Solo un administrador general puede aprobar o rechazar esta solicitud.</p>
          <label className="mt-3 block">
            Nota de revisión
            <textarea className="field mt-1" rows={3} value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)} maxLength={1000} />
          </label>
          <div className="mt-3 flex gap-2">
            <button className="btn-mini" type="button" onClick={() => review("approved")} disabled={saving}>
              Aprobar cobros
            </button>
            <button className="btn-mini" type="button" onClick={() => review("rejected")} disabled={saving}>
              Rechazar
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
