export default function ReportWidget({ report }) {
  if (!report) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
        Cargando reporte…
      </div>
    );
  }

  const bars = [
    { label: "Emitidas", value: report.issued, color: "bg-slate-400" },
    { label: "Redimidas", value: report.redeemed, color: "bg-emerald-400" },
    { label: "Pendientes", value: report.pending, color: "bg-indigo-400" },
    { label: "Anuladas", value: report.voided, color: "bg-red-400" },
  ];

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-lg font-bold text-white">{report.event_name}</h3>
        <span className="text-sm text-slate-400">
          Aforo <b className="text-white">{report.occupancy_pct}%</b> · {report.capacity} cupos
        </span>
      </div>

      {/* Barra de ocupación */}
      <div className="mb-4 h-3 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-indigo-400 transition-all"
          style={{ width: `${Math.min(report.occupancy_pct, 100)}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {bars.map((b) => (
          <div key={b.label} className="rounded-xl bg-slate-800/60 p-3">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className={`h-2 w-2 rounded-full ${b.color}`} />
              {b.label}
            </div>
            <div className="mt-1 text-2xl font-bold text-white">{b.value}</div>
          </div>
        ))}
      </div>

      {report.by_promoter?.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Por promotor
          </h4>
          <div className="space-y-1">
            {report.by_promoter.map((p) => (
              <div key={p.promoter_id} className="flex justify-between text-sm">
                <span className="text-slate-300">{p.full_name}</span>
                <span className="text-slate-400">
                  {p.issued}/{p.capacity} cupos · {p.redeemed} en puerta
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}