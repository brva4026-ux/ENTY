/** Marca TicketFlow: logotipo y componentes de identidad reutilizables. */

export function Logo({ size = "md" }) {
  const box = size === "lg" ? "h-11 w-11" : "h-8 w-8";
  const text = size === "lg" ? "text-3xl" : "text-lg";
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className={`${box} grid place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-accent-500 shadow-lg shadow-brand-600/30`}>
        <svg viewBox="0 0 24 24" className="h-[60%] w-[60%] text-white" fill="currentColor">
          <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.2a2.8 2.8 0 0 0 0 5.6V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.2a2.8 2.8 0 0 0 0-5.6V7z" />
          <path d="M11.25 5h1.5v14h-1.5z" fill="#0f172a" opacity="0.45" />
        </svg>
      </span>
      <span className={`${text} font-black tracking-tight text-white`}>
        Ticket<span className="bg-gradient-to-r from-brand-400 to-accent-400 bg-clip-text text-transparent">Flow</span>
      </span>
    </span>
  );
}

const STATUS_STYLES = {
  draft: "bg-slate-700/60 text-slate-300 ring-slate-600",
  published: "bg-sky-500/15 text-sky-300 ring-sky-500/40",
  live: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
  ended: "bg-slate-700/40 text-slate-400 ring-slate-600",
  cancelled: "bg-red-500/15 text-red-300 ring-red-500/40",
};
const STATUS_LABELS = {
  draft: "Borrador",
  published: "Publicada",
  live: "En puerta",
  ended: "Finalizada",
  cancelled: "Cancelada",
};

export function EventStatusBadge({ status }) {
  const cls = STATUS_STYLES[status] ?? STATUS_STYLES.draft;
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${cls}`}>
      {status === "live" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
      {label}
    </span>
  );
}

/** Medidor de cupo: "usados X de Y" con barra y color por presión de uso. */
export function QuotaMeter({ used, total, label, compact = false }) {
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const barColor =
    pct >= 100 ? "bg-red-400" : pct >= 80 ? "bg-amber-400" : "bg-brand-400";
  return (
    <div className={compact ? "" : "rounded-xl bg-slate-800/50 p-3"}>
      <div className="mb-1.5 flex items-baseline justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="tnum font-bold text-white">
          {used}
          <span className="font-medium text-slate-500">/{total}</span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700/60">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {pct >= 100 && (
        <p className="mt-1 text-[11px] font-semibold text-red-400">Cupo agotado</p>
      )}
    </div>
  );
}

/** Barra de progreso suelta, para desgloses que no son un cupo. */
export function Bar({ pct, tone = "brand", gradient }) {
  const tones = {
    brand: "bg-brand-400",
    emerald: "bg-emerald-400",
    amber: "bg-amber-400",
    red: "bg-red-400",
  };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
      <div
        className={`h-full rounded-full transition-all duration-700 ${
          gradient ? `bg-gradient-to-r ${gradient}` : tones[tone]
        }`}
        style={{ width: `${Math.max(0, Math.min(pct, 100))}%` }}
      />
    </div>
  );
}

/** Tarjeta de KPI del command deck. `i` escalona la entrada. */
export function Stat({ label, value, accent = "slate", i = 0 }) {
  const dots = {
    slate: "bg-slate-400",
    emerald: "bg-emerald-400",
    brand: "bg-brand-400",
    red: "bg-red-400",
  };
  return (
    <div className="stat stagger p-3.5" style={{ "--i": i }}>
      <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
        <span className={`h-2 w-2 rounded-full ${dots[accent]}`} />
        {label}
      </div>
      <div className="tnum mt-1.5 font-display text-3xl font-extrabold leading-none tracking-tight text-white">
        {value}
      </div>
    </div>
  );
}
