import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { money } from "../lib/format";
import CountUpNumber from "./CountUpNumber";
import { STATUS_META } from "./EventWorkbench";
import EmptyState from "./EmptyState";
import Icon from "./Icon";

/** Descarga autenticada del resumen mensual (CSV para el contador). */
async function downloadOverviewCsv(venueId, month) {
  const token = localStorage.getItem("tf_token");
  const res = await fetch(
    `/api/venues/${venueId}/overview.csv${month ? `?month=${month}` : ""}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (!res.ok) throw new Error("No se pudo exportar el CSV");
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `resumen-${month || "mes-actual"}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

function labelMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function shiftMonth(ym, delta) {
  let [y, m] = ym.split("-").map(Number);
  m += delta;
  if (m < 1) {
    m = 12;
    y -= 1;
  }
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

/** Delta % entre mes actual y anterior (null si no hay base comparable). */
function trendPct(current, prev) {
  if (prev > 0) return Math.round(((current - prev) / prev) * 100);
  // Sin base: si este mes vendió algo es +100%, si no, no hay tendencia que
  // mostrar (no fingimos un 0% engañoso).
  return current > 0 ? 100 : null;
}

function TrendPill({ current, prev, invert = false }) {
  const pct = trendPct(current, prev);
  if (pct === null)
    return <span className="text-[10px] text-zinc-600">sin mes anterior</span>;
  const up = pct > 0;
  const flat = pct === 0;
  // invert=true: para costes, subir es malo (aquí no aplica, pero queda por si acaso)
  const good = invert ? !up : up;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
        flat
          ? "bg-zinc-800 text-zinc-400"
          : good
            ? "bg-emerald-500/15 text-emerald-300"
            : "bg-red-500/15 text-red-300"
      }`}
    >
      {flat ? "=" : up ? "▲" : "▼"} {Math.abs(pct)}%
    </span>
  );
}

function KpiCard({ label, value, accent, children, format }) {
  // value es string (viene formateado) o número (cuenta al entrar); `format`
  // permite contar cifras con formato propio (dinero) sin perder animación.
  const isNumber = typeof value === "number";
  return (
    <div className="card card-interactive p-4">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className={`tnum mt-1 text-2xl font-bold ${accent ?? "text-white"}`}>
        {isNumber ? (
          <CountUpNumber
            value={value}
            format={format ?? ((v) => String(Math.round(v)))}
          />
        ) : (
          value
        )}
      </p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/** Barras del mes: altura proporcional al recaudo de cada evento. Es un
 *  gráfico honesto (misma respuesta del API, cero librería) que deja VER de
 *  dónde salió el recaudo del mes — no solo el total. Se ancla desde abajo
 *  y crece con transición al montar. */
function RevenueBars({ events, onOpen }) {
  const max = Math.max(...events.map((e) => e.revenue_cents), 1);
  return (
    <div
      role="img"
      aria-label="Recaudo por evento del mes"
      className="flex h-28 items-end gap-2"
    >
      {events.map((e, i) => {
        const h = Math.max(6, Math.round((e.revenue_cents / max) * 100));
        const meta = STATUS_META[e.status] ?? STATUS_META.draft;
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => onOpen?.(e.id)}
            data-tip={`${e.name}: ${money(e.revenue_cents)}`}
            className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
          >
            <span
              className={`w-full max-w-10 rounded-t-md transition-all duration-500 group-hover:brightness-125 ${
                e.status === "live"
                  ? "bg-gradient-to-t from-emerald-600/70 to-emerald-400"
                  : "bg-gradient-to-t from-brand-700/60 to-brand-500"
              }`}
              style={{ height: `${h}%`, transitionDelay: `${i * 60}ms` }}
            />
            <span className="w-full truncate text-[9px] text-zinc-500 group-hover:text-zinc-300">
              {e.name}
            </span>
            <span
              className={`hidden shrink-0 rounded-full px-1.5 text-[8px] font-bold uppercase ring-1 sm:block ${meta.cls}`}
            >
              {meta.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Vista del NEGOCIO entre eventos: la que faltaba. Todo por mes natural
 * (zona del venue), criterio contable idéntico al reporte por evento:
 * boletas vivas facturan; anuladas/reembolsadas no.
 */
export default function BusinessOverview({ venueId, onOpenEvent }) {
  const [month, setMonth] = useState(null); // null = "mes actual" (lo fija el API)
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const qs = month ? `?month=${month}` : "";
    apiFetch(`/venues/${venueId}/overview${qs}`)
      .then((d) => {
        if (!alive) return;
        setData(d);
        if (!month) setMonth(d.month); // el API dice el mes en curso
        setError("");
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [venueId, month]);

  const now = new Date();
  const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const isCurrent = month === currentYM;

  if (error) {
    return (
      <div className="rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Navegación histórica: mes anterior / siguiente (sin futuro) */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setMonth((m) => shiftMonth(m ?? currentYM, -1))}
            className="btn-ghost !px-3 !py-1.5 text-xs"
            aria-label="Mes anterior"
          >
            ←
          </button>
          <span className="display min-w-36 text-center text-base capitalize">
            {month ? labelMonth(month) : "…"}
          </span>
          <button
            onClick={() => setMonth((m) => shiftMonth(m ?? currentYM, 1))}
            disabled={isCurrent}
            className="btn-ghost !px-3 !py-1.5 text-xs disabled:opacity-30"
            aria-label="Mes siguiente"
          >
            →
          </button>
        </div>{" "}
        {!isCurrent && month && (
          <button
            onClick={() => setMonth(null)}
            className="btn-ghost text-xs font-bold"
          >
            Volver al mes actual
          </button>
        )}
        {month && (
          <button
            onClick={() =>
              downloadOverviewCsv(venueId, month).catch((e) =>
                setError(e.message),
              )
            }
            className="btn-ghost text-xs font-bold"
            data-tip="Hoja lista para el contador"
          >
            Descargar CSV
          </button>
        )}
      </div>

      {loading && !data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton card h-24" />
            ))}
          </div>
          <div className="skeleton card h-36" />
        </>
      ) : (
        data && (
          <>
            {/* KPIs del mes con tendencia */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                label="Recaudo del mes"
                value={data.revenue_cents / 100}
                format={(v) => `$${Math.round(v).toLocaleString("es-CO")}`}
                accent="text-emerald-300"
              >
                <TrendPill
                  current={data.revenue_cents}
                  prev={data.prev_revenue_cents}
                />
              </KpiCard>
              <KpiCard label="Boletas vendidas" value={data.tickets_issued}>
                <TrendPill
                  current={data.tickets_issued}
                  prev={data.prev_tickets_issued}
                />
              </KpiCard>
              <KpiCard
                label="Ingresaron"
                value={data.tickets_redeemed}
                accent="text-brand-300"
              >
                <span className="text-[10px] text-zinc-600">
                  {data.tickets_issued > 0
                    ? `${Math.round((data.tickets_redeemed / data.tickets_issued) * 100)}% de las vendidas`
                    : "—"}
                </span>
              </KpiCard>
              <KpiCard
                label="Promedio por boleta paga"
                value={
                  data.avg_ticket_cents ? money(data.avg_ticket_cents) : "—"
                }
              >
                <span className="text-[10px] text-zinc-600">
                  {data.courtesy_tickets} cortesías aparte
                </span>
              </KpiCard>
            </div>

            {/* Dónde salió el recaudo: una barra por evento del mes */}
            {data.top_events.length > 0 && (
              <div className="card p-5">
                <p className="display mb-3 text-base">Recaudo por evento</p>
                <RevenueBars events={data.top_events} onOpen={onOpenEvent} />
              </div>
            )}

            {data.events_count === 0 ? (
              <div className="card p-5">
                <EmptyState
                  icon="door"
                  title={`Sin eventos en ${labelMonth(data.month)}`}
                >
                  Navega a los meses anteriores con las flechas, o crea el
                  próximo evento.
                </EmptyState>
              </div>
            ) : (
              <div className="grid gap-5 lg:grid-cols-2">
                {/* Top promotores del mes */}
                <div className="card p-5">
                  <p className="display mb-3 text-base">Mejores promotores</p>
                  {data.top_promoters.length === 0 ? (
                    <p className="text-sm text-zinc-500">
                      Nadie vendió con cupo propio este mes (las ventas directas
                      del admin no entran al ranking).
                    </p>
                  ) : (
                    <ol className="space-y-2">
                      {data.top_promoters.map((p, i) => (
                        <li
                          key={p.name}
                          className="flex items-center gap-3 text-sm"
                        >
                          <span
                            className={`tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                              i === 0
                                ? "bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/40"
                                : "bg-zinc-800 text-zinc-400"
                            }`}
                          >
                            {i + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-medium text-zinc-200">
                            {p.name}
                          </span>
                          <span className="tnum text-xs text-zinc-400">
                            {p.tickets} boletas
                          </span>
                          <span className="tnum w-24 text-right text-xs font-semibold text-emerald-300">
                            {money(p.revenue_cents)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>

                {/* Eventos del mes con su aporte */}
                <div className="card p-5">
                  <p className="display mb-3 text-base">
                    Eventos del mes
                    <span className="ml-2 text-xs font-normal text-zinc-500">
                      {data.events_count} en total
                    </span>
                  </p>
                  <ul className="divide-y divide-zinc-800/70">
                    {data.top_events.map((e) => (
                      <li key={e.id}>
                        <button
                          onClick={() => onOpenEvent?.(e.id)}
                          className="flex w-full items-center gap-3 py-2 text-left text-sm transition hover:bg-zinc-900/40"
                        >
                          <Icon
                            name="door"
                            className="h-3.5 w-3.5 shrink-0 text-zinc-500"
                          />
                          <span className="min-w-0 flex-1 truncate font-medium text-zinc-200">
                            {e.name}
                          </span>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ring-1 ${
                              (STATUS_META[e.status] ?? STATUS_META.draft).cls
                            }`}
                          >
                            {(STATUS_META[e.status] ?? STATUS_META.draft).label}
                          </span>
                          <span className="tnum w-20 text-right text-xs font-semibold text-emerald-300">
                            {money(e.revenue_cents)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
