import { AnimatedNumber } from "./Brand";

const fmtCOP = (cents) =>
  `$${(cents / 100).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;

export default function ReportWidget({ report }) {
  if (!report) {
    return (
      <div className="card p-5">
        <div className="skeleton h-6 w-48" />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-16" />
          ))}
        </div>
      </div>
    );
  }

  const occupancy = Math.min(report.occupancy_pct, 100);
  const fill =
    occupancy >= 90 ? "bg-red-500" : occupancy >= 70 ? "bg-amber-500" : "bg-brand-600";

  // Tipos con datos, ordenados por recaudo desc.
  const breakdown = (report.by_type || [])
    .filter((t) => t.issued > 0 || (t.is_active !== false && !t.is_courtesy))
    .sort((a, b) => b.revenue_cents - a.revenue_cents || b.issued - a.issued);

  const stats = [
    { label: "Emitidas", value: report.issued },
    { label: "Redimidas", value: report.redeemed },
    { label: "Pendientes", value: report.pending },
    { label: "Anuladas", value: report.voided },
  ];

  return (
    <div className="card">
      {/* Cabecera del reporte */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-800/80 px-5 py-4">
        <div>
          <p className="eyebrow">Reporte en vivo</p>
          <h3 className="display mt-0.5 text-lg">{report.event_name}</h3>
        </div>
        <p className="tnum text-sm text-zinc-500">
          Aforo <span className="font-semibold text-zinc-200">{report.occupancy_pct}%</span>
          <span className="mx-1.5 text-zinc-700">·</span>
          {report.capacity} cupos
        </p>
      </div>

      <div className="p-5">
        {/* Recaudo: la cifra principal, arriba a la izquierda como en un dashboard financiero */}
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Recaudo</p>
            <p className="tnum display mt-1 text-4xl text-white">
              <AnimatedNumber
                value={report.revenue_cents / 100}
                format={(v) =>
                  `$${Math.round(v).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`
                }
              />
            </p>
            <p className="mt-1 text-xs text-zinc-600">
              Boletas activas al precio de emisión · anular lo reduce
            </p>
          </div>
        </div>

        {/* Ocupación */}
        <div className="meter mb-1">
          <div className={`meter-fill ${fill}`} style={{ width: `${occupancy}%` }} />
        </div>
        <div className="mb-5 flex justify-between text-[11px] text-zinc-600">
          <span>Ocupación</span>
          <span className="tnum">{occupancy}%</span>
        </div>

        {/* Métricas: fila única con separadores verticales, sin cajitas */}
        <div className="grid grid-cols-2 divide-zinc-800/80 sm:grid-cols-4 sm:divide-x">
          {stats.map((b) => (
            <div key={b.label} className="px-2 py-2 first:pl-0 sm:text-center">
              <p className="text-xs text-zinc-500">{b.label}</p>
              <p className="tnum display mt-0.5 text-2xl">
                <AnimatedNumber value={b.value} />
              </p>
            </div>
          ))}
        </div>

        {/* Desglose por tipo: filas divididas con columnas numéricas alineadas */}
        {breakdown.length > 0 && (
          <div className="mt-6">
            <p className="eyebrow mb-2">Por tipo de boleta</p>
            <div className="divide-list reveal overflow-hidden rounded-lg border border-zinc-800/80">
              {breakdown.map((t) => (
                <div
                  key={t.ticket_type_id}
                  className={`grid grid-cols-[1fr_auto] items-center gap-2 px-3.5 py-2.5 sm:grid-cols-[1fr_auto_auto] ${
                    t.is_active === false ? "opacity-50" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-zinc-200">
                    <span className="truncate">{t.name}</span>
                    {t.is_courtesy && (
                      <span className="badge bg-zinc-800/80 text-zinc-400">cortesía</span>
                    )}
                    {t.is_active === false && (
                      <span className="badge bg-amber-950/60 text-amber-400">archivado</span>
                    )}
                  </span>
                  <span className="tnum hidden text-right text-xs text-zinc-500 sm:block">
                    {t.issued}/{t.quantity} emitidas
                    <span className="mx-1 text-zinc-700">·</span>
                    {t.redeemed} en puerta
                  </span>
                  <span className="tnum text-right text-sm font-semibold text-white">
                    {t.revenue_cents > 0 ? fmtCOP(t.revenue_cents) : <span className="font-normal text-zinc-600">—</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Por promotor: mismo lenguaje visual */}
        {report.by_promoter?.length > 0 && (
          <div className="mt-6">
            <p className="eyebrow mb-2">Por promotor</p>
            <div className="divide-list overflow-hidden rounded-lg border border-zinc-800/80">
              {report.by_promoter.map((p) => {
                const pct = p.capacity > 0 ? Math.min((p.issued / p.capacity) * 100, 100) : 0;
                return (
                  <div key={p.promoter_id} className="px-3.5 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium text-zinc-200">{p.full_name}</span>
                      <span className="tnum shrink-0 text-xs text-zinc-500">
                        {p.issued}/{p.capacity} cupos
                        <span className="mx-1 text-zinc-700">·</span>
                        {p.redeemed} en puerta
                      </span>
                    </div>
                    <div className="meter mt-2">
                      <div className="meter-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
