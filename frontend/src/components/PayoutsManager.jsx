/* Liquidaciones de promotores (vista admin).
 *
 * El cierre nace de los datos: se elige promotor + rango y el backend
 * agrega sus ventas reales del periodo y congela la comisión de la venue.
 * Ciclo: pending -> (disputa) -> paid/rejected. Las cerradas son historia.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useUI } from "../lib/ui";
import EmptyState from "./EmptyState";

const fmtCOP = (cents) =>
  `$${Math.round((cents || 0) / 100).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;

const STATUS_BADGE = {
  pending: ["Pendiente", "bg-amber-950/60 text-amber-300 ring-amber-800/60"],
  disputed: ["Disputada", "bg-red-950/60 text-red-300 ring-red-800/60"],
  paid: ["Pagada", "bg-emerald-950/60 text-emerald-300 ring-emerald-800/60"],
  rejected: ["Rechazada", "bg-zinc-800 text-zinc-400 ring-zinc-700"],
};

function StatusPill({ status }) {
  const [label, cls] = STATUS_BADGE[status] ?? [status, "bg-zinc-800 text-zinc-300 ring-zinc-700"];
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-2xs font-bold uppercase ring-1 ${cls}`}>
      {label}
    </span>
  );
}

export default function PayoutsManager({ venueId, users }) {
  const ui = useUI();
  const [payouts, setPayouts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    promoter_id: "",
    period_start: "",
    period_end: "",
  });
  const [reviewFor, setReviewFor] = useState(null);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewAmount, setReviewAmount] = useState("");

  const promoters = (users || []).filter((u) => (u.roles || []).includes("promotor") && u.is_active !== false);

  const load = useCallback(() => {
    apiFetch(`/venues/${venueId}/payouts`)
      .then(setPayouts)
      .catch(() => setPayouts([]));
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function generate(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const created = await apiFetch(`/venues/${venueId}/payouts/generate`, {
        method: "POST",
        body: JSON.stringify({
          promoter_id: Number(form.promoter_id),
          period_start: form.period_start,
          period_end: form.period_end,
        }),
      });
      load();
      ui.success(
        `Liquidación creada: ${created.tickets_count} boletas · comisión ${fmtCOP(created.commission_cents)}`,
      );
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  async function review(p, action) {
    setErr("");
    try {
      const body = { action, note: reviewNote || null };
      if (action === "pay" && reviewAmount !== "") {
        body.paid_cents = Math.round(Number(reviewAmount) * 100);
      }
      const updated = await apiFetch(`/venues/${venueId}/payouts/${p.id}/review`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setReviewFor(null);
      setReviewNote("");
      setReviewAmount("");
      load();
      ui.success(
        action === "pay"
          ? `Liquidación pagada: ${fmtCOP(updated.paid_cents)}`
          : "Liquidación rechazada con nota",
      );
    } catch (e2) {
      setErr(e2.message);
    }
  }

  const pendingCount = (payouts || []).filter((p) => p.status === "pending" || p.status === "disputed").length;

  return (
    <div className="space-y-4">
      {/* Cerrar liquidación */}
      <div className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="eyebrow">Cierre de periodo</p>
            <h3 className="display mt-0.5 text-base">Generar liquidación</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Suma las ventas reales del promotor en el rango y aplica la comisión de la venue
              (se congela al cierre).
            </p>
          </div>
        </div>
        <form onSubmit={generate} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
          <select
            value={form.promoter_id}
            onChange={(e) => setForm({ ...form, promoter_id: e.target.value })}
            className="field"
            required
            aria-label="Promotor"
          >
            <option value="">Promotor…</option>
            {promoters.map((u) => (
              <option key={u.id} value={u.id}>{u.full_name}</option>
            ))}
          </select>
          <input
            type="date"
            value={form.period_start}
            onChange={(e) => setForm({ ...form, period_start: e.target.value })}
            className="field"
            required
            aria-label="Desde"
          />
          <input
            type="date"
            value={form.period_end}
            onChange={(e) => setForm({ ...form, period_end: e.target.value })}
            className="field"
            required
            aria-label="Hasta"
          />
          <button disabled={busy || promoters.length === 0} className="btn-primary">
            {busy ? "Calculando…" : "Cerrar liquidación"}
          </button>
        </form>
        {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
        {promoters.length === 0 && (
          <p className="mt-2 text-xs text-amber-400">
            No hay promotores activos en el equipo: agrégalos en la sección Equipo.
          </p>
        )}
      </div>

      {/* Historial de liquidaciones */}
      <div className="card p-5">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h3 className="display text-base">Liquidaciones</h3>
          {pendingCount > 0 && (
            <span className="rounded-full bg-amber-950/60 px-2 py-0.5 text-2xs font-bold uppercase text-amber-300 ring-1 ring-amber-800/60">
              {pendingCount} por revisar
            </span>
          )}
        </div>
        {payouts === null ? (
          <div className="space-y-2">
            {[0, 1].map((i) => <div key={i} className="skeleton h-16" />)}
          </div>
        ) : payouts.length === 0 ? (
          <EmptyState icon="money" title="Aún no hay liquidaciones">
            Cierra el primer periodo arriba: el recaudo se calcula de las boletas reales del promotor.
          </EmptyState>
        ) : (
          <ul className="divide-list overflow-hidden rounded-lg border border-zinc-800/80">
            {payouts.map((p) => (
              <li key={p.id} className="px-3.5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-zinc-200">{p.promoter_name}</span>
                      <StatusPill status={p.status} />
                    </div>
                    <p className="tnum mt-0.5 text-xs text-zinc-500">
                      {p.period_start} → {p.period_end} · {p.tickets_count} boletas ·{" "}
                      {fmtCOP(p.revenue_cents)} vendidos · {p.commission_pct}%
                    </p>
                    {p.disputed_reason && (
                      <p className="mt-1 rounded-md bg-red-950/40 px-2 py-1 text-xs text-red-300">
                        Disputa: {p.disputed_reason}
                      </p>
                    )}
                    {p.review_note && (
                      <p className="mt-1 text-xs text-zinc-500">Nota: {p.review_note}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="tnum display text-xl text-ink">
                      {fmtCOP(p.status === "paid" ? p.paid_cents : p.commission_cents)}
                    </p>
                    {(p.status === "pending" || p.status === "disputed") && (
                      <button
                        onClick={() => {
                          setReviewFor(reviewFor === p.id ? null : p.id);
                          setReviewAmount(
                            p.status === "paid" || p.commission_cents
                              ? (p.commission_cents / 100).toString()
                              : "",
                          );
                        }}
                        className="btn-ghost mt-1 text-xs font-bold"
                      >
                        {p.status === "disputed" ? "Resolver disputa" : "Revisar"}
                      </button>
                    )}
                    {p.status === "paid" && (
                      <p className="text-2xs uppercase tracking-wide text-emerald-500">
                        pagada {p.paid_at ? new Date(p.paid_at).toLocaleDateString("es-CO") : ""}
                      </p>
                    )}
                  </div>
                </div>

                {reviewFor === p.id && (
                  <div className="mt-3 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <label className="text-xs text-zinc-400">
                        Monto a pagar (COP)
                        <input
                          type="number"
                          min="0"
                          step="100"
                          value={reviewAmount}
                          onChange={(e) => setReviewAmount(e.target.value)}
                          className="field mt-1 py-1 text-sm"
                          placeholder={(p.commission_cents / 100).toString()}
                        />
                      </label>
                      <label className="text-xs text-zinc-400">
                        Nota (obligatoria para rechazar)
                        <input
                          value={reviewNote}
                          onChange={(e) => setReviewNote(e.target.value)}
                          className="field mt-1 py-1 text-sm"
                          placeholder="Ej: verificado contra el escaneo"
                        />
                      </label>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => review(p, "pay")} className="btn-primary px-3 py-1 text-xs font-bold">
                        Marcar pagada
                      </button>
                      <button
                        onClick={() => review(p, "reject")}
                        className="btn-ghost px-3 py-1 text-xs font-bold text-red-400"
                      >
                        Rechazar
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
