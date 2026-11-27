import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { activeVenueId } from "../lib/venue";
import { apiFetch } from "../lib/api";
import { currentYM, labelMonth, money, shiftMonth } from "../lib/format";
import useDocumentTitle from "../lib/useDocumentTitle";
import BusinessOverview from "../components/BusinessOverview";
import PaymentsPanel from "../components/PaymentsPanel";
import PayoutsManager from "../components/PayoutsManager";
import DoorSection from "../components/DoorSection";
import PromotersSection from "../components/PromotersSection";
import FunnelPage from "./FunnelPage";
import Icon from "../components/Icon";

const TABS = [
  { id: "ventas", label: "Ventas y caja", icon: "money" },
  { id: "conversion", label: "Conversión", icon: "chart" },
  { id: "resultados", label: "Puerta y promotores", icon: "users" },
];

function MoneyCard({ label, value, note, tone }) {
  return (
    <div className={`admin-money-card ${tone ? `is-${tone}` : ""}`}>
      <small>{label}</small>
      <b>{value}</b>
      <span>{note}</span>
    </div>
  );
}

export default function AdminReportsPage() {
  useDocumentTitle("Reportes");
  const { user } = useAuth();
  const venueId = activeVenueId(user);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const tab = TABS.some((t) => t.id === rawTab) ? rawTab : "ventas";
  const month = searchParams.get("mes");
  const nowMonth = currentYM();
  const shownMonth = month || nowMonth;
  const isCurrent = shownMonth === nowMonth;

  const [events, setEvents] = useState([]);
  const [users, setUsers] = useState([]);
  const [overview, setOverview] = useState(null);
  const [overviewError, setOverviewError] = useState("");

  useEffect(() => {
    if (!venueId) return;
    let alive = true;
    setOverview(null);
    setOverviewError("");
    const qs = month ? `?month=${month}` : "";
    apiFetch(`/venues/${venueId}/overview${qs}`)
      .then((d) => alive && setOverview(d))
      .catch((e) => alive && setOverviewError(e.message));
    apiFetch(`/venues/${venueId}/events`)
      .then((rows) => alive && setEvents(rows || []))
      .catch(() => alive && setEvents([]));
    apiFetch(`/venues/${venueId}/users?include_inactive=true`)
      .then((rows) => alive && setUsers(rows || []))
      .catch(() => alive && setUsers([]));
    return () => {
      alive = false;
    };
  }, [venueId, month]);

  function selectTab(id) {
    const next = new URLSearchParams(searchParams);
    if (id === "ventas") next.delete("tab");
    else next.set("tab", id);
    setSearchParams(next);
  }

  function setMonth(next) {
    const params = new URLSearchParams(searchParams);
    if (!next || next === nowMonth) params.delete("mes");
    else params.set("mes", next);
    setSearchParams(params, { replace: true });
  }

  if (!venueId) {
    return (
      <div className="admin-empty">
        <h2>Sin organización activa</h2>
        <p>Habla con un administrador general para que te asigne un negocio.</p>
      </div>
    );
  }

  return (
    <div className="admin-events admin-reports-page">
      <header className="admin-page-head admin-hub-head">
        <div>
          <h1>Reportes</h1>
          <p>Consulta ingresos, conversión de compra y resultados de puerta.</p>
        </div>
        <div className="admin-tabs" role="tablist" aria-label="Secciones de Reportes">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => selectTab(t.id)}
              className="admin-tab"
            >
              <Icon name={t.icon} className="h-4 w-4" aria-hidden="true" />
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {tab === "ventas" && (
        <section className="space-y-5" role="tabpanel" aria-label="Ventas y caja">
          <div className="admin-report-period">
            <div>
              <h2>Ventas y caja</h2>
              <p className="admin-note">Cifras de {labelMonth(shownMonth)}</p>
            </div>
            <div className="admin-month-nav">
              <button
                type="button"
                onClick={() => setMonth(shiftMonth(shownMonth, -1))}
                className="btn-mini btn-icon"
                data-variant="brand"
                aria-label="Mes anterior"
              >
                <Icon name="back" className="h-3.5 w-3.5" />
              </button>
              <span className="admin-month-label">{labelMonth(shownMonth)}</span>
              <button
                type="button"
                onClick={() => setMonth(shiftMonth(shownMonth, 1))}
                className="btn-mini btn-icon"
                data-variant="brand"
                aria-label="Mes siguiente"
                disabled={isCurrent}
              >
                <Icon name="back" className="h-3.5 w-3.5 rotate-180" />
              </button>
              {!isCurrent && (
                <button
                  type="button"
                  onClick={() => setMonth(null)}
                  className="admin-inline-link"
                >
                  Volver al mes actual
                </button>
              )}
            </div>
          </div>

          {overviewError ? (
            <div className="admin-error" role="alert">
              No pudimos cargar la caja del mes: {overviewError}
            </div>
          ) : (
            <div className="admin-money-strip" aria-busy={!overview}>
              <MoneyCard
                label="Vendido"
                value={overview ? money(overview.revenue_cents) : "—"}
                note={`Boletas vivas de eventos de ${labelMonth(shownMonth)}.`}
              />
              <MoneyCard
                label="Cobrado"
                value={overview ? money(overview.collected_cents ?? 0) : "—"}
                note={`Pagos aprobados en ${labelMonth(shownMonth)}${
                  overview?.pending_collection_cents
                    ? ` · ${money(overview.pending_collection_cents)} pendiente`
                    : ""
                }.`}
                tone="collected"
              />
              <MoneyCard
                label="Liquidado"
                value={overview ? money(overview.settled_cents ?? 0) : "—"}
                note={`Pagos a promotores realizados en ${labelMonth(shownMonth)}.`}
                tone="settled"
              />
            </div>
          )}

          <BusinessOverview
            venueId={venueId}
            month={month}
            onOpenEvent={(id) => navigate(`/admin?event=${id}&tab=resumen`)}
          />

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="space-y-3" aria-labelledby="cobros-title">
              <div>
                <h2 id="cobros-title" className="display text-base">
                  Cobros por evento
                </h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Enlaces de pago, estado de Wompi y boleta emitida.
                </p>
              </div>
              <PaymentsPanel venueId={venueId} events={events} />
            </section>
            <section className="space-y-3" aria-labelledby="liquidaciones-title">
              <div>
                <h2 id="liquidaciones-title" className="display text-base">
                  Liquidaciones de promotores
                </h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Comisiones generadas, en disputa y pagadas.
                </p>
              </div>
              <PayoutsManager venueId={venueId} users={users} />
            </section>
          </div>
        </section>
      )}

      {tab === "conversion" && (
        <section className="card p-4" role="tabpanel" aria-label="Conversión de compra">
          <FunnelPage embedded />
        </section>
      )}

      {tab === "resultados" && (
        <section className="space-y-5" role="tabpanel" aria-label="Puerta y promotores">
          <div className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="eyebrow">Resultados de la organización</p>
                <p className="mt-1 text-sm text-zinc-400">
                  Totales y comparaciones entre noches. La operación de una sola
                  noche vive dentro de Evento → Accesos.
                </p>
              </div>
              <div className="admin-month-nav">
                <button
                  type="button"
                  onClick={() => setMonth(shiftMonth(shownMonth, -1))}
                  className="btn-mini btn-icon"
                  data-variant="brand"
                  aria-label="Mes anterior"
                >
                  <Icon name="back" className="h-3.5 w-3.5" />
                </button>
                <span className="admin-month-label">{labelMonth(shownMonth)}</span>
                <button
                  type="button"
                  onClick={() => setMonth(shiftMonth(shownMonth, 1))}
                  className="btn-mini btn-icon"
                  data-variant="brand"
                  aria-label="Mes siguiente"
                  disabled={isCurrent}
                >
                  <Icon name="back" className="h-3.5 w-3.5 rotate-180" />
                </button>
              </div>
            </div>
          </div>
          <DoorSection
            venueId={venueId}
            onOpenEvent={(id) => navigate(`/admin?event=${id}&tab=accesos`)}
          />
          <PromotersSection venueId={venueId} month={month} />
        </section>
      )}
    </div>
  );
}
