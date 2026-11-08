import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { activeVenueId } from "../lib/venue";
import { fetchVenueFunnel } from "../lib/api";
import { money } from "../lib/format";
import useDocumentTitle from "../lib/useDocumentTitle";

/**
 * Métricas del embudo: vitrina → evento → checkout → pago.
 *
 * Solo admin de la venue. El backend cuenta SESIONES (no visitas) para los tres
 * primeros pasos y TRANSACCIONES aprobadas para el último: por eso cada paso
 * declara su unidad en vez de fingir que el embudo cierra exacto.
 */

const RANGES = [
  { days: 7, label: "7 días" },
  { days: 30, label: "30 días" },
  { days: 90, label: "90 días" },
];

export default function FunnelPage() {
  useDocumentTitle("Métricas");
  const { user } = useAuth();
  const venueId = activeVenueId(user);
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!venueId) return;
    let alive = true;
    setData(null);
    setError("");
    fetchVenueFunnel(venueId, days)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message || "No pudimos cargar las métricas"));
    return () => {
      alive = false;
    };
  }, [venueId, days]);

  const steps = data?.steps ?? [];
  const top = steps[0]?.count ?? 0;
  const empty = data && steps.every((s) => s.count === 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 text-zinc-100">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Métricas</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Embudo de conversión: de ver la vitrina a pagar. Las sesiones se
            cuentan una vez, sin cookies.
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Rango de fechas">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              aria-pressed={days === r.days}
              onClick={() => setDays(r.days)}
              className={`min-h-11 rounded-full px-4 text-sm font-semibold transition ${
                days === r.days
                  ? "bg-violet-600 text-white"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <p role="alert" className="mt-6 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : !data ? (
        <div className="mt-6 space-y-3" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-zinc-800/60" />
          ))}
        </div>
      ) : empty ? (
        <p className="mt-8 rounded-xl border border-zinc-700/60 px-4 py-6 text-sm text-zinc-400">
          Todavía no hay visitas registradas en este periodo. Los datos aparecen
          cuando alguien abre la vitrina desde el link público.
        </p>
      ) : (
        <ol className="mt-6 space-y-3">
          {steps.map((s) => {
            const pct = top ? Math.round((s.count / top) * 100) : 0;
            return (
              <li key={s.key} className="rounded-xl border border-zinc-700/60 bg-zinc-900/60 p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-zinc-200">{s.label}</span>
                  <span className="text-sm tabular-nums text-zinc-400">
                    <b className="text-base text-zinc-100">{s.count}</b> {s.unit}
                  </span>
                </div>
                <div
                  className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800"
                  role="img"
                  aria-label={`${s.label}: ${s.count} ${s.unit} (${pct}% del primer paso)`}
                >
                  <div
                    className="h-full rounded-full bg-violet-500"
                    style={{ width: `${Math.max(pct, s.count ? 3 : 0)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {data && !empty && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/60 p-4">
            <p className="text-xs uppercase tracking-wider text-zinc-500">Conversión</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">
              {data.conversion_pct}%
            </p>
            <p className="mt-1 text-xs text-zinc-500">pagos sobre sesiones que vieron la vitrina</p>
          </div>
          <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/60 p-4">
            <p className="text-xs uppercase tracking-wider text-zinc-500">Recaudado</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">
              {money(data.revenue_cents)}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              pagos aprobados (fuente: caja, no eventos del navegador)
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
