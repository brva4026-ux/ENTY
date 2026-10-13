import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { money, labelMonth } from "../lib/format";
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
    return <span className="text-2xs text-zinc-600">sin mes anterior</span>;
  const up = pct > 0;
  const flat = pct === 0;
  // invert=true: para costes, subir es malo (aquí no aplica, pero queda por si acaso)
  const good = invert ? !up : up;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-bold ${
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
      <p className="text-2xs font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p
        className={`tnum mt-1.5 text-3xl font-extrabold leading-none tracking-[-0.03em] ${accent ?? "text-white"}`}
        style={{ fontVariationSettings: '"opsz" 32' }}
      >
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
      className="flex h-28 items-stretch gap-2"
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
            className="group flex min-w-0 flex-1 flex-col items-center gap-1"
          >
            {/* El wrapper flex-1 da altura DEFINIDA: el height % de la barra
              necesita un padre con altura real (un % sobre altura auto colapsa
              a 0 y el gráfico se veia vacio). */}
            <span className="flex min-h-0 w-full flex-1 items-end justify-center">
              <span
                className={`revbar w-full max-w-10 rounded-t-md transition-all duration-500 group-hover:brightness-125 ${
                  e.status === "live" ? "is-live" : ""
                } ${
                  e.status === "live"
                    ? "bg-gradient-to-t from-emerald-600/70 to-emerald-400"
                    : "bg-gradient-to-t from-brand-700/60 to-brand-500"
                }`}
                style={{ height: `${h}%`, transitionDelay: `${i * 60}ms` }}
              />
            </span>
            <span className="w-full truncate text-2xs text-zinc-500 group-hover:text-zinc-300">
              {e.name}
            </span>
            <span
              className={`hidden shrink-0 rounded-full px-1.5 text-2xs font-bold uppercase ring-1 sm:block ${meta.cls}`}
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
 * Ranking de promotores con barra proporcional: el orden lo da la cifra,
 * la MAGNITUD la da la barra — un ranking solo-numeros obliga a hacer
 * aritmética mental para saber que el #1 duplicó al #2. Mismo idioma visual
 * de RevenueBars (brand-500, transición con stagger) sin SVG nuevo.
 * La cifra que manda es BOLETAS: en el MVP el promotor coloca cortesías.
 */
function PromoterBars({ promoters }) {
  // El ranking se mide en BOLETAS, no en dinero: en el MVP la boleta de pago
  // es venta directa (sin cupo) y `emit_ticket` rechaza atar una boleta de
  // pago a un promotor, así que el promotor mueve cortesías y su
  // `revenue_cents` es 0 SIEMPRE. Medir por dinero dejaba barras vacías y
  // "$ 0" en todas las filas. El dinero se muestra solo si existe (cuando
  // entre la venta por cupo), para no perder la métrica si el modelo cambia.
  const max = Math.max(...promoters.map((p) => p.tickets), 1);
  const showMoney = promoters.some((p) => p.revenue_cents > 0);
  return (
    <ol
      role="img"
      aria-label="Boletas colocadas por promotor del mes"
      className="space-y-2.5"
    >
      {promoters.map((p, i) => {
        const w = Math.max(4, Math.round((p.tickets / max) * 100));
        return (
          <li key={p.name} className="text-sm">
            <div className="flex items-center gap-2.5">
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
              <span className="tnum shrink-0 text-xs font-semibold text-zinc-300">
                {p.tickets} {p.tickets === 1 ? "boleta" : "boletas"}
                {p.has_courtesy && (
                  <span className="ml-1 font-normal text-zinc-500">
                    cortesía
                  </span>
                )}
              </span>
              {showMoney && (
                <span className="tnum w-24 shrink-0 text-right text-xs font-semibold text-emerald-300">
                  {money(p.revenue_cents)}
                </span>
              )}
            </div>
            {/* La barra debajo del nombre: llena el ancho de la fila sin
                competir con las cifras (que quedan alineadas en columna). */}
            <div className="revbar ml-8.5 mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-brand-700/70 to-brand-500 transition-all duration-500"
                style={{
                  width: `${w}%`,
                  transitionDelay: `${i * 60}ms`,
                }}
              />
            </div>
          </li>
       );
      })
      }
    </ol>
  );
}

/**
 * Ritmo de venta: CUÁNDO se vendió el mes, no cuánto. El total (recaudo,
 * boletas) ya está arriba; esto responde "¿vendí por impulso la última noche
 * o con semanas de anticipación?", que es lo que decide cuándo empujar la
 * preventa. Barras horizontales (magnitud proporcional, como el ranking de
 * promotores): una serie de anticipación se lee de arriba (lejano) abajo
 * (últimos días), que es el orden natural de una línea de tiempo.
 */
const ANTICIPATION_LABELS = {
  "30+": "30+ días antes",
  "15-29": "15–29 días",
  "8-14": "8–14 días",
  "2-7": "2–7 días",
  "0-1": "Últimos 2 días",
};

function SalesCurve({ curve }) {
  const total = curve.reduce((n, b) => n + b.tickets, 0);
  if (total === 0) {
    return (
      <div className="card p-5">
        <p className="display mb-3 text-base">Ritmo de venta</p>
        <p className="text-sm text-zinc-500">
          Aún no hay boletas vendidas este mes para medir con cuánta
          anticipación se compran.
        </p>
      </div>
    );
  }
  const max = Math.max(...curve.map((b) => b.tickets), 1);
  return (
    <div className="card p-5">
      <p className="display text-base">Ritmo de venta</p>
      <p className="mb-3 mt-1 text-xs text-zinc-500">
        Con cuánta anticipación se vendieron las {total} boletas del mes.
      </p>
      <ul
        className="space-y-2.5"
        role="img"
        aria-label={`Ritmo de venta: ${curve
          .map((b) => `${ANTICIPATION_LABELS[b.bucket] ?? b.bucket} ${b.tickets}`)
          .join(", ")}`}
      >
        {curve.map((b, i) => {
          const w = Math.max(b.tickets > 0 ? 4 : 0, Math.round((b.tickets / max) * 100));
          return (
            <li key={b.bucket} className="text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-zinc-300">
                  {ANTICIPATION_LABELS[b.bucket] ?? b.bucket}
                </span>
                <span className="tnum shrink-0 text-xs font-semibold text-zinc-200">
                  {b.tickets}{" "}
                  {b.tickets === 1 ? "boleta" : "boletas"}
                  {b.revenue_cents > 0 && (
                    <span className="ml-2 font-normal text-emerald-300">
                      {money(b.revenue_cents)}
                    </span>
                  )}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-brand-700/70 to-brand-500 transition-all duration-500"
                  style={{ width: `${w}%`, transitionDelay: `${i * 60}ms` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Retención: de los compradores del mes, cuántos ya habían comprado aquí
 * antes. Es la métrica que distingue "crecí porque traje gente nueva" de
 * "crecí porque la gente volvió" — dos negocios distintos. Solo cuenta a
 * quien dejó teléfono (el backend excluye al resto), por eso el copy aclara
 * la base: no inflamos "nuevos" con datos que no existen.
 */
function RetentionCard({ buyers, returning }) {
  if (buyers === 0) {
    return (
      <div className="card p-5">
        <p className="display mb-3 text-base">Clientes que vuelven</p>
        <p className="text-sm text-zinc-500">
          Sin compradores con teléfono este mes no se puede medir la
          recurrencia (un cliente solo cuenta si dejó su teléfono).
        </p>
      </div>
    );
  }
  const fresh = buyers - returning;
  const pct = Math.round((returning / buyers) * 100);
  return (
    <div className="card p-5">
      <p className="display text-base">Clientes que vuelven</p>
      <p className="mb-3 mt-1 text-xs text-zinc-500">
        De {buyers} {buyers === 1 ? "comprador" : "compradores"} con teléfono
        este mes.
      </p>
      {/* Barra partida: recurrente (violeta, el valor que se quiere crecer)
          vs nuevo (gris). Una cifra sola no dice la PROPORCIÓN. */}
      <div
        className="flex h-3 overflow-hidden rounded-full bg-zinc-800"
        role="img"
        aria-label={`${returning} recurrentes y ${fresh} nuevos de ${buyers} compradores`}
      >
        <div
          className="h-full bg-gradient-to-r from-brand-700 to-brand-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <div>
          <p className="tnum text-2xl font-extrabold text-brand-300">
            <CountUpNumber value={pct} format={(v) => `${Math.round(v)}%`} />
          </p>
          <p className="text-2xs text-zinc-500">vuelven</p>
        </div>
        <div>
          <p className="tnum text-lg font-bold text-zinc-200">{returning}</p>
          <p className="text-2xs text-zinc-500">recurrentes</p>
        </div>
        <div>
          <p className="tnum text-lg font-bold text-zinc-200">{fresh}</p>
          <p className="text-2xs text-zinc-500">nuevos</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Vista del NEGOCIO entre eventos: la que faltaba. Todo por mes natural
 * (zona del venue), criterio contable idéntico al reporte por evento:
 * boletas vivas facturan; anuladas/reembolsadas no.
 */
export default function BusinessOverview({ venueId, month, onOpenEvent }) {
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
        setError("");
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [venueId, month]);

  if (error) {
    return (
      <div className="rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* El mes NO se navega aquí: la portada (VenueHeader) es la dueña del
          mes y lo comparte por la URL. Reportes solo muestra el título del
          mes abierto y ofrece la exportación. Dos navegadores de mes en la
          misma pantalla (portada + reportes) se desincronizaban. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="display text-base capitalize">
          {data?.month ? labelMonth(data.month) : "…"}
        </span>
        {data?.month && (
          <button
            onClick={() =>
              downloadOverviewCsv(venueId, data.month).catch((e) =>
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
            {/* KPIs del mes con tendencia (5: recaudo, boletas, ingresaron,
                comisiones, promedio) — en xl entran en una sola fila. */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
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
                <span className="text-2xs text-zinc-600">
                  {data.tickets_issued > 0
                    ? `${Math.round((data.tickets_redeemed / data.tickets_issued) * 100)}% de las vendidas`
                    : "—"}
                </span>
              </KpiCard>
              <KpiCard
                label="Comisiones"
                value={
                  data.commissions_cents !== null
                    ? data.commissions_cents / 100
                    : 0
                }
                format={(v) => `$${Math.round(v).toLocaleString("es-CO")}`}
                accent="text-rose-300"
              >
                <span className="text-2xs text-zinc-600">
                  {data.commissions_cents !== null
                    ? "se descuentan del recaudo"
                    : "sin liquidaciones este mes"}
                </span>
              </KpiCard>
              <KpiCard
                label="Promedio por boleta paga"
                value={
                  data.avg_ticket_cents ? money(data.avg_ticket_cents) : "—"
                }
              >
                <span className="text-2xs text-zinc-600">
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

            {/* Dos preguntas del negocio que el TOTAL no responde: CUÁNDO se
                vendió (ritmo) y QUIÉN volvió (retención). Van juntas por ser
                las dos de "comportamiento del cliente", no de caja. */}
            <div className="grid gap-5 lg:grid-cols-2">
              <SalesCurve curve={data.sales_curve ?? []} />
              <RetentionCard
                buyers={data.retention_buyers ?? 0}
                returning={data.retention_returning ?? 0}
              />
            </div>

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
                  <p className="display mb-3 text-base">
                    Promotores del mes
                    <span className="ml-2 text-xs font-normal text-zinc-500">
                      boletas con cupo propio
                    </span>
                  </p>
                  {data.top_promoters.length === 0 ? (
                    <p className="text-sm text-zinc-500">
                      Nadie colocó boletas con cupo propio este mes (las ventas
                      directas del admin no entran al ranking).
                    </p>
                  ) : (
                    <PromoterBars promoters={data.top_promoters} />
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
                            className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-bold uppercase ring-1 ${
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
