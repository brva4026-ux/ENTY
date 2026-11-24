import { useEffect, useState } from "react";
import Icon from "../../components/Icon";
import { PromoterAlert, PromoterDrawer, PromoterEmpty, PromoterSkeleton, PromoterStatus } from "../../components/PromoterUI";
import { useAuth } from "../../lib/auth";
import { useUI } from "../../lib/ui";
import { activeVenueId } from "../../lib/venue";
import {
  apiFetch,
  fetchPromoterCommissions,
  fetchPromoterPayout,
} from "../../lib/api";
import { eventDate, money } from "../../lib/format";
import { channelLabel, payoutClass, payoutStatusLabel, priceLabel } from "../../lib/promoter";

function periodLabel(payout) {
  const start = new Date(`${payout.period_start}T12:00:00`);
  const end = new Date(`${payout.period_end}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${payout.period_start} — ${payout.period_end}`;
  }
  const opts = { day: "numeric", month: "short" };
  return `${start.toLocaleDateString("es-CO", opts)} — ${end.toLocaleDateString("es-CO", { ...opts, year: "numeric" })}`;
}

export default function PromoterCommissionsView() {
  const { user } = useAuth();
  const venueId = activeVenueId(user);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [payoutId, setPayoutId] = useState(null);

  async function load() {
    if (!venueId) return;
    setError("");
    try {
      setData(await fetchPromoterCommissions(venueId));
    } catch (err) {
      setError(err.message || "No pudimos cargar tus comisiones.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId]);

  if (!data && !error) return <PromoterSkeleton rows={2} />;

  return (
    <div className="promoter-page">
      <div className="promoter-head">
        <div>
          <span className="promoter-toplabel"><Icon name="money" className="h-3 w-3" aria-hidden="true" />Tu dinero</span>
          <h1>Comisiones</h1>
          <p>
            Lo que generaste, lo que la organización ya te pagó y lo que falta
            por liquidar. Cada peso sale de una boleta real, no de una proyección.
          </p>
        </div>
        <button type="button" className="promoter-btn" onClick={load}>
          <Icon name="undo" aria-hidden="true" />
          Actualizar
        </button>
      </div>

      {error && (
        <PromoterAlert tone="danger" action={<button type="button" onClick={load}>Reintentar</button>}>
          {error}
        </PromoterAlert>
      )}

      {data && (
        <>
          {data.commission_pct === 0 && (
            <PromoterAlert tone="warn">
              La organización todavía no configuró una comisión. Las ventas se
              registran, pero la liquidación daría $0 hasta que la tarifa exista.
            </PromoterAlert>
          )}

          <div className="promoter-commission-grid">
            <div className="promoter-commission-card is-primary">
              <span>Generado</span>
              <b>{money(data.generated_cents)}</b>
              <small>Incluye liquidaciones pagadas y pendientes.</small>
            </div>
            <div className="promoter-commission-card">
              <span>Pendiente de liquidar</span>
              <b>{money(data.pending_settlement_cents)}</b>
              <small>Ventas cerradas y liquidaciones aún sin pago.</small>
            </div>
            <div className="promoter-commission-card">
              <span>Pagado</span>
              <b>{money(data.paid_cents)}</b>
              <small>{data.commission_pct}% sobre ventas atribuidas.</small>
            </div>
          </div>

          <section className="promoter-panel">
            <div className="promoter-panel-head">
              <div>
                <h2 className="promoter-panel-title">Liquidaciones</h2>
                <p className="promoter-panel-hint">
                  {data.payouts.length === 0
                    ? "Cuando la organización cierre un periodo, aparecerá aquí."
                    : "Abre una liquidación para ver las boletas incluidas y reclamar si no cuadra."}
                </p>
              </div>
              <span className="promoter-hint">
                {data.eligible_sales_count} {data.eligible_sales_count === 1 ? "venta" : "ventas"} con base · {money(data.attributed_revenue_cents)} atribuidos
              </span>
            </div>

            {data.payouts.length === 0 ? (
              <PromoterEmpty
                icon="money"
                title={data.eligible_sales_count ? "Aún no hay liquidaciones" : "Aún no hay ventas pagadas"}
              >
                {data.eligible_sales_count
                  ? "Tus ventas ya están registradas. La organización debe generar el cierre del periodo para convertirlas en una liquidación."
                  : "Emite boletas pagadas o comparte tu link. Las cortesías no generan comisión."}
              </PromoterEmpty>
            ) : (
              <div className="promoter-payout-list">
                {data.payouts.map((p) => (
                  <button key={p.id} type="button" className="promoter-payout-card" onClick={() => setPayoutId(p.id)}>
                    <div>
                      <b>{periodLabel(p)}</b>
                      <p>{p.tickets_count} {p.tickets_count === 1 ? "boleta" : "boletas"} · {money(p.revenue_cents)} en ventas</p>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <PromoterStatus tone={payoutClass(p.status)}>{payoutStatusLabel(p.status)}</PromoterStatus>
                      <span className="is-amount">{money(p.commission_cents)}</span>
                      <Icon name="arrowRight" className="h-4 w-4" aria-hidden="true" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="promoter-panel">
            <div className="promoter-panel-head">
              <div>
                <h2 className="promoter-panel-title">Cómo se calcula</h2>
              </div>
            </div>
            <p className="promoter-kit-note">{data.definition}</p>
            <div className="promoter-summary">
              <div className="promoter-summary-row"><span>Tarifa de la organización</span><b>{data.commission_pct}%</b></div>
              <div className="promoter-summary-row"><span>Ventas con base</span><b>{data.eligible_sales_count}</b></div>
              <div className="promoter-summary-row"><span>Valor atribuido</span><b>{money(data.attributed_revenue_cents)}</b></div>
            </div>
          </section>
        </>
      )}

      {payoutId && (
        <PayoutDrawer venueId={venueId} payoutId={payoutId} onClose={() => setPayoutId(null)} onChanged={load} />
      )}
    </div>
  );
}

function PayoutDrawer({ venueId, payoutId, onClose, onChanged }) {
  const ui = useUI();
  const [payout, setPayout] = useState(null);
  const [error, setError] = useState("");
  const [dispute, setDispute] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setError("");
    try {
      setPayout(await fetchPromoterPayout(venueId, payoutId));
    } catch (err) {
      setError(err.message || "No pudimos abrir la liquidación.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, payoutId]);

  async function sendDispute() {
    if (dispute.trim().length < 10) return;
    setBusy(true);
    try {
      await apiFetch(`/venues/${venueId}/payouts/${payoutId}/dispute`, {
        method: "POST",
        body: JSON.stringify({ reason: dispute.trim() }),
      });
      setDispute("");
      await load();
      onChanged?.();
      ui.toast("Reclamo enviado a la organización.", "success");
    } catch (err) {
      ui.error(err.message || "No pudimos enviar el reclamo.");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <PromoterDrawer title="Liquidación" onClose={onClose} footer={<button type="button" className="promoter-btn" onClick={onClose}>Cerrar</button>}>
        <PromoterAlert tone="danger" action={<button type="button" onClick={load}>Reintentar</button>}>{error}</PromoterAlert>
      </PromoterDrawer>
    );
  }
  if (!payout) return <PromoterDrawer title="Cargando liquidación" onClose={onClose}><PromoterSkeleton rows={1} /></PromoterDrawer>;

  return (
    <PromoterDrawer
      title={periodLabel(payout)}
      subtitle={`${payout.tickets_count} ${payout.tickets_count === 1 ? "boleta" : "boletas"} · ${payoutStatusLabel(payout.status)}`}
      onClose={onClose}
      footer={<button type="button" className="promoter-btn" onClick={onClose}>Cerrar</button>}
    >
      <div className="promoter-summary">
        <div className="promoter-summary-row"><span>Ventas del periodo</span><b>{money(payout.base_cents)}</b></div>
        <div className="promoter-summary-row"><span>Comisión ({payout.commission_pct}%)</span><b>{money(payout.commission_cents)}</b></div>
        {payout.adjustment_cents !== 0 && (
          <div className="promoter-summary-row"><span>Ajuste al pagar</span><b>{money(payout.adjustment_cents)}</b></div>
        )}
        <div className="promoter-summary-row promoter-summary-total"><span>Total</span><b>{money(payout.commission_cents + payout.adjustment_cents)}</b></div>
      </div>
      <p className="promoter-kit-note">{payout.rule}</p>

      <div className="promoter-payout-detail">
        <span className="promoter-label">Boletas incluidas</span>
        {payout.items.length === 0 && <p className="promoter-hint">No hay boletas registradas en este periodo.</p>}
        {payout.items.map((item) => (
          <div key={item.ticket_id} className="promoter-payout-item">
            <div>
              <b>{item.customer_name}</b>
              <p className="promoter-hint">{item.event_name} · {item.ticket_type} · {channelLabel(item.sale_channel)}</p>
            </div>
            <div style={{ textAlign: "right" }}>
              <b>{priceLabel(item.price_cents)}</b>
              <p className="promoter-hint">{eventDate(item.issued_at)}</p>
            </div>
          </div>
        ))}
      </div>

      {payout.status === "disputed" && payout.disputed_reason && (
        <PromoterAlert tone="warn">Reclamo enviado: {payout.disputed_reason}</PromoterAlert>
      )}
      {payout.status === "rejected" && (
        <PromoterAlert tone="danger">
          La organización rechazó esta liquidación{payout.review_note ? `: ${payout.review_note}` : "."}
        </PromoterAlert>
      )}
      {payout.status === "paid" && (
        <PromoterAlert tone="ok">Pago registrado{payout.paid_at ? ` el ${eventDate(payout.paid_at)}` : ""}.</PromoterAlert>
      )}
      {payout.can_dispute && (
        <div className="promoter-summary">
          <label className="promoter-field">
            <span className="promoter-label">¿No cuadra? Cuéntale a la organización</span>
            <textarea
              className="promoter-input"
              value={dispute}
              onChange={(e) => setDispute(e.target.value)}
              placeholder="Ejemplo: falta la boleta #0012 del 12 de noviembre."
            />
            <span className="promoter-hint">Mínimo 10 caracteres. La liquidación queda en revisión.</span>
          </label>
          <button type="button" className="promoter-btn promoter-btn--danger" onClick={sendDispute} disabled={busy || dispute.trim().length < 10}>
            Enviar reclamo
          </button>
        </div>
      )}
    </PromoterDrawer>
  );
}
