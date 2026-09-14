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
  const barColor =
    occupancy >= 90 ? "bg-red-400" : occupancy >= 70 ? "bg-amber-400" : "bg-brand-400";

  const stats = [
    { label: "Emitidas", value: report.issued, dot: "bg-slate-400" },
    { label: "Redimidas", value: report.redeemed, dot: "bg-emerald-400" },
    { label: "Pendientes", value: report.pending, dot: "bg-brand-400" },
    { label: "Anuladas", value: report.voided, dot: "bg-red-400" },
  ];

  return (
    <div className="card p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xl font-black tracking-tight text-white">{report.event_name}</h3>
        <span className="tnum text-sm text-slate-400">
          Aforo <b className="tnum text-white">{report.occupancy_pct}%</b> · {report.capacity} cupos
        </span>
      </div>

      {/* Barra de ocupación */}
      <div className="mb-5 h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-all duration-700 ${barColor}`}
          style={{ width: `${occupancy}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((b) => (
          <div
            key={b.label}
            className="rounded-xl bg-slate-800/50 p-3.5 ring-1 ring-slate-700/50 transition hover:ring-slate-600"
          >
            <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
              <span className={`h-2 w-2 rounded-full ${b.dot}`} />
              {b.label}
            </div>
            <div className="tnum mt-1 text-3xl font-black tracking-tight text-white">{b.value}</div>
          </div>
        ))}
      </div>

      {report.by_promoter?.length > 0 && (
        <div className="mt-5">
          <h4 className="mb-2.5 text-xs font-bold uppercase tracking-wider text-slate-500">
            Por promotor
          </h4>
          <div className="space-y-2.5">
            {report.by_promoter.map((p) => {
              const pct = p.capacity > 0 ? Math.min((p.issued / p.capacity) * 100, 100) : 0;
              return (
                <div key={p.promoter_id} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 truncate text-sm font-medium text-slate-300">
                    {p.full_name}
                  </span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500 transition-all duration-700"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="tnum w-32 shrink-0 text-right text-xs text-slate-400">
                    {p.issued}/{p.capacity} cupos · {p.redeemed} en puerta
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
