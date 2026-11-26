import { useEffect, useMemo, useState } from "react";
import {
  createCost,
  deleteCost,
  getBreakEven,
  updateCost,
} from "../lib/api";
import { money, plural } from "../lib/format";
import { useUI } from "../lib/ui";
import Icon from "./Icon";

const STATUS_LABEL = {
  estimated: "Estimado",
  committed: "Registrado",
  paid: "Pagado",
};

const RESULT_META = {
  sin_costos: {
    label: "Sin costos",
    tone: "draft",
    hint: "Registra lo que cuesta la noche para saber cuánto falta vender.",
  },
  cubierto: {
    label: "Cubierto",
    tone: "live",
    hint: "La caja ya cubre el costo registrado. Lo que entre de aquí es margen.",
  },
  en_camino: {
    label: "En camino",
    tone: "published",
    hint: "Con el inventario que queda al precio actual, el evento cubre su costo.",
  },
  en_riesgo: {
    label: "En riesgo",
    tone: "cancelled",
    hint: "Ni vendiendo todo el inventario al precio actual se cubre el costo.",
  },
};

const EMPTY_FORM = {
  description: "",
  category: "produccion",
  amount: "",
  status: "estimated",
  notes: "",
};

function categoryLabel(value) {
  return value ? value.replaceAll("_", " ") : "otro";
}

export default function BreakEvenPanel({ venueId, eventId }) {
  const ui = useUI();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);

  const result = RESULT_META[data?.status] ?? RESULT_META.sin_costos;

  const progress = useMemo(() => {
    if (!data || !data.target_cents) return 0;
    return Math.max(0, Math.min(100, data.covered_pct));
  }, [data]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setData(await getBreakEven(venueId, eventId));
    } catch (err) {
      setError(err.message || "No pudimos calcular el punto de equilibrio.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, eventId]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
  }

  function startEdit(cost) {
    setEditingId(cost.id);
    setForm({
      description: cost.description,
      category: cost.category || "otro",
      amount: String(Math.round(cost.amount_cents / 100)),
      status: cost.status,
      notes: cost.notes || "",
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!form.description.trim()) {
      setError("Describe el costo.");
      return;
    }
    const amount = Math.round(Number(form.amount || 0) * 100);
    if (!Number.isFinite(amount) || amount < 0) {
      setError("El monto no puede ser negativo.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = {
        description: form.description.trim(),
        category: form.category,
        amount_cents: amount,
        status: form.status,
        notes: form.notes.trim() || null,
      };
      if (editingId) {
        await updateCost(venueId, eventId, editingId, payload);
        ui.toast("Costo actualizado.", "success");
      } else {
        await createCost(venueId, eventId, payload);
        ui.toast("Costo registrado.", "success");
      }
      resetForm();
      await load();
    } catch (err) {
      setError(err.message || "No pudimos guardar el costo.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(cost) {
    const ok = await ui.confirm(`¿Eliminar “${cost.description}”?`, {
      body: "El punto de equilibrio se recalcula sin este costo.",
      confirmLabel: "Eliminar",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteCost(venueId, eventId, cost.id);
      ui.toast("Costo eliminado.", "success");
      if (editingId === cost.id) resetForm();
      await load();
    } catch (err) {
      ui.error(err.message || "No pudimos eliminar el costo.");
    }
  }

  return (
    <div className="admin-panel-card bs-break-even">
      <div className="bs-box-office-head">
        <div>
          <h2>Punto de equilibrio</h2>
          <p>
            Registra lo que cuesta la noche y Enty te dice cuánto falta vender
            para cubrirlo, con la caja real y el inventario que queda.
          </p>
        </div>
        <span className="bs-status" data-status={result.tone}>
          <span className="bs-status-dot" aria-hidden="true" />
          {result.label}
        </span>
      </div>

      {error && (
        <p className="admin-note" role="alert" data-tone="warn">
          {error}
        </p>
      )}

      {loading || !data ? (
        <p className="admin-note">Calculando el equilibrio…</p>
      ) : (
        <>
          <div className="bs-break-even-hero">
            <div>
              <span className="bs-break-even-kicker">
                {data.status === "cubierto" ? "Margen sobre el costo" : "Falta por vender"}
              </span>
              <strong className="bs-break-even-number tnum">
                {data.status === "cubierto"
                  ? money(Math.max(0, data.collected_cents - data.target_cents))
                  : money(data.remaining_cents)}
              </strong>
              <p>{result.hint}</p>
            </div>
            <div
              className="bs-break-even-ring"
              style={{ "--pct": `${progress}%` }}
              role="img"
              aria-label={`${progress}% del costo cubierto`}
            >
              <span>{progress}%</span>
              <small>cubierto</small>
            </div>
          </div>

          <div className="bs-state-grid bs-state-grid--metrics bs-break-even-metrics">
            <div className="bs-metric">
              <span>Costo base</span>
              <strong className="tnum">{money(data.target_cents)}</strong>
              <small>
                {data.target_basis === "registrado"
                  ? "Costos registrados o pagados."
                  : data.target_basis === "estimado"
                    ? "Solo hay costos estimados."
                    : "Aún no registraste costos."}
              </small>
            </div>
            <div className="bs-metric">
              <span>Cobrado</span>
              <strong className="tnum">{money(data.collected_cents)}</strong>
              <small>
                {money(data.gross_revenue_cents)} en boletas −{" "}
                {money(data.refunded_cents)} reembolsado.
              </small>
            </div>
            <div className="bs-metric">
              <span>Boletas por vender</span>
              <strong className="tnum">
                {data.status === "cubierto" ? "0" : data.tickets_remaining ?? "—"}
              </strong>
              <small>
                {data.avg_ticket_cents > 0
                  ? `A ${money(data.avg_ticket_cents)} ${
                      data.avg_ticket_basis === "ventas"
                        ? "promedio vendido"
                        : "de lista"
                    }.`
                  : "Sin precio de referencia."}
              </small>
            </div>
            <div className="bs-metric">
              <span>Proyección</span>
              <strong
                className="tnum"
                data-tone={data.projected_result_cents < 0 ? "warn" : undefined}
              >
                {money(data.projected_result_cents)}
              </strong>
              <small>
                Si se vende el inventario restante ({data.capacity_left}{" "}
                {plural(data.capacity_left, "boleta", "boletas")}).
              </small>
            </div>
          </div>

          <div className="bs-break-even-bar" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>

          <div className="bs-break-even-totals">
            <span>
              <b>Estimado</b> {money(data.estimated_cents)}
            </span>
            <span>
              <b>Registrado</b> {money(data.committed_cents)}
            </span>
            <span>
              <b>Pagado</b> {money(data.paid_cents)}
            </span>
          </div>

          <div className="bs-break-even-split">
            <div className="bs-break-even-costs">
              <div className="bs-subnav-head">
                <h3>Costos de la noche</h3>
                <span className="bs-break-even-count">
                  {data.costs.length}{" "}
                  {plural(data.costs.length, "costo", "costos")}
                </span>
              </div>
              {data.costs.length === 0 ? (
                <p className="admin-note">
                  Aún no hay costos. Empieza por el alquiler, el sonido o el
                  personal de puerta.
                </p>
              ) : (
                <div className="bs-cost-list">
                  {data.costs.map((cost) => (
                    <div className="bs-cost-row" key={cost.id}>
                      <div>
                        <strong>{cost.description}</strong>
                        <p>
                          {categoryLabel(cost.category)} ·{" "}
                          {STATUS_LABEL[cost.status] ?? cost.status}
                          {cost.notes ? ` · ${cost.notes}` : ""}
                        </p>
                      </div>
                      <span className="bs-cost-amount tnum">
                        {money(cost.amount_cents)}
                      </span>
                      <div className="bs-cost-actions">
                        <button
                          type="button"
                          className="bs-icon-button"
                          onClick={() => startEdit(cost)}
                          aria-label={`Editar ${cost.description}`}
                        >
                          <Icon name="edit" className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className="bs-icon-button"
                          onClick={() => remove(cost)}
                          aria-label={`Eliminar ${cost.description}`}
                        >
                          <Icon name="trash" className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <form className="bs-cost-form" onSubmit={submit}>
              <h3>{editingId ? "Editar costo" : "Nuevo costo"}</h3>
              <label className="bs-field">
                <span>Descripción</span>
                <input
                  className="field"
                  placeholder="Sonido, alquiler, personal…"
                  value={form.description}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, description: e.target.value }))
                  }
                />
              </label>
              <div className="bs-form-row">
                <label className="bs-field">
                  <span>Monto (COP)</span>
                  <input
                    className="field"
                    type="number"
                    min="0"
                    step="100"
                    placeholder="1200000"
                    value={form.amount}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, amount: e.target.value }))
                    }
                  />
                </label>
                <label className="bs-field">
                  <span>Etapa</span>
                  <select
                    className="field"
                    value={form.status}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, status: e.target.value }))
                    }
                  >
                    <option value="estimated">Estimado</option>
                    <option value="committed">Registrado</option>
                    <option value="paid">Pagado</option>
                  </select>
                </label>
              </div>
              <label className="bs-field">
                <span>Categoría</span>
                <select
                  className="field"
                  value={form.category}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, category: e.target.value }))
                  }
                >
                  <option value="produccion">Producción</option>
                  <option value="talento">Talento</option>
                  <option value="sonido">Sonido e iluminación</option>
                  <option value="personal">Personal</option>
                  <option value="marketing">Marketing</option>
                  <option value="logistica">Logística</option>
                  <option value="otro">Otro</option>
                </select>
              </label>
              <label className="bs-field">
                <span>Nota (opcional)</span>
                <input
                  className="field"
                  placeholder="Factura, proveedor, fecha de pago…"
                  value={form.notes}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, notes: e.target.value }))
                  }
                />
              </label>
              <div className="bs-cost-form-actions">
                <button type="submit" className="btn-primary" disabled={busy}>
                  {busy
                    ? "Guardando…"
                    : editingId
                      ? "Guardar cambios"
                      : "Agregar costo"}
                </button>
                {editingId && (
                  <button type="button" className="bs-secondary" onClick={resetForm}>
                    Cancelar
                  </button>
                )}
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
