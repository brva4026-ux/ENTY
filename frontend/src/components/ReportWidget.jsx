/**
 * Command deck del evento. Es la pantalla que el admin abre en la puerta
 * para saber, de un vistazo, si el evento esta sano: cuanto entro de plata,
 * cuanta gente paso y si alguien intento colarse.
 *
 * Jerarquia deliberada: los ingresos mandan, el aforo los acompana, y la
 * integridad de la puerta cierra como alerta. Todo lo demas es detalle.
 */
import { Bar, Stat } from "./Brand";
import OccupancyRing from "./OccupancyRing";
import { clockTime, money, timeAgo } from "../lib/format";

function Skeleton() {
  return (
    <div className="card-hero p-6">
      <div className="skeleton h-5 w-56" />
      <div className="mt-6 grid gap-6 lg:grid-cols-[auto_1fr]">
        <div className="skeleton h-32 w-32 rounded-full" />
        <div className="grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-20" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ReportWidget({ report }) {
  if (!report) return <Skeleton />;

  const door = report.door ?? {};
  const live = false;
  const occupancy = Math.min(report.occupancy_pct ?? 0, 100);
  const soldOut = occupancy >= 95;
  const failed = door.failed ?? 0;
  // Tasa de rechazo: lo que separa "nadie intento colarse" de "el QR se filtra".
  const rejectRate = door.total > 0 ? Math.round((failed / door.total) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* --- Cabecera + aforo ------------------------------------------- */}
      <div className="card-hero stagger p-6" style={{ "--i": 0 }}>
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="eyebrow">Reporte en vivo</p>
            <h3 className="mt-1.5 font-display text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
              {report.event_name}
            </h3>
            <p className="tnum mt-1 text-sm text-slate-500">
              {report.capacity.toLocaleString("es-CO")} personas de aforo
            </p>
          </div>
          <OccupancyRing
            pct={occupancy}
            used={report.issued}
            total={report.capacity}
            live={live}
          />
        </div>

        {soldOut && (
          <p className="relative mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-300">
            Aforo casi agotado — considera cerrar venta para no sobrevender la puerta.
          </p>
        )}
      </div>

      {/* --- Caja ------------------------------------------------------- */}
      <div
        className="card stagger overflow-hidden"
        style={{ "--i": 1, borderColor: "rgba(245,158,11,0.22)" }}
      >
        <div className="flex flex-wrap items-end justify-between gap-4 p-5">
          <div>
            <p className="eyebrow">Ingresos del evento</p>
            <p className="tnum mt-2 font-display text-4xl font-extrabold leading-none text-gold-300 sm:text-5xl">
              {money(report.revenue_cents)}
            </p>
            <p className="tnum mt-2.5 text-xs text-slate-500">
              {report.paid_tickets} boletas pagas · ticket promedio{" "}
              <span className="font-semibold text-slate-300">
                {money(report.avg_ticket_cents)}
              </span>
            </p>
          </div>
          <div className="flex gap-5 text-right">
            <div>
              <p className="eyebrow">Cortesías</p>
              <p className="tnum mt-1 font-display text-2xl font-extrabold text-slate-200">
                {report.courtesy_tickets}
              </p>
            </div>
            <div>
              <p className="eyebrow">Anuladas</p>
              <p className="tnum mt-1 font-display text-2xl font-extrabold text-slate-200">
                {report.voided}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* --- Pulso de la operacion -------------------------------------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Emitidas" value={report.issued} accent="slate" i={2} />
        <Stat label="En puerta" value={report.redeemed} accent="emerald" i={3} />
        <Stat label="Sin entrar" value={report.pending} accent="brand" i={4} />
        <Stat label="Anuladas" value={report.voided} accent="red" i={5} />
      </div>

      {/* --- Integridad de la puerta ------------------------------------ */}
      <div className="card stagger p-5" style={{ "--i": 6 }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="eyebrow">Integridad de la puerta</p>
            <p className="mt-1 text-sm text-slate-400">
              {door.total === 0
                ? "Sin escaneos todavía."
                : `${door.total} escaneos · ${rejectRate}% rechazado`}
            </p>
          </div>
          {door.last_granted_at && (
            <p className="tnum font-mono text-xs text-slate-500">
              último acceso {clockTime(door.last_granted_at)}
            </p>
          )}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3">
          <MiniStat label="Aceptados" value={door.granted ?? 0} tone="emerald" />
          <MiniStat label="Duplicados" value={door.already_redeemed ?? 0} tone="amber" />
          <MiniStat label="QR inválidos" value={door.not_found ?? 0} tone="red" />
        </div>

        {failed > 0 && (
          <p className="mt-3.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-300/90">
            <b className="font-semibold text-amber-200">{failed} intentos rechazados.</b>{" "}
            Revisa duplicados y capturas: es la señal de boletas clonadas
            {door.last_scan_at ? ` (último ${timeAgo(door.last_scan_at)})` : ""}.
          </p>
        )}

        {door.scanned_by?.length > 0 && (
          <ul className="mt-4 space-y-1.5 border-t border-slate-800 pt-3">
            {door.scanned_by.map((s) => (
              <li
                key={s.full_name}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="truncate text-slate-400">{s.full_name}</span>
                <span className="tnum shrink-0 font-mono text-slate-500">
                  {s.granted} ok · {s.failed} rechaz.
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --- Desglose por tipo ------------------------------------------ */}
      {report.by_type?.length > 0 && (
        <div className="card stagger p-5" style={{ "--i": 7 }}>
          <p className="eyebrow">Por tipo de boleta</p>
          <ul className="mt-4 space-y-3.5">
            {report.by_type.map((t) => {
              const pct = t.quantity > 0 ? Math.min((t.issued / t.quantity) * 100, 100) : 0;
              return (
                <li key={t.name}>
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                      {t.name}
                      {t.is_courtesy && (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300 ring-1 ring-emerald-500/30">
                          cortesía
                        </span>
                      )}
                    </span>
                    <span className="tnum font-mono text-xs text-slate-400">
                      {t.issued}/{t.quantity}
                      <span className="text-gold-400"> · {money(t.revenue_cents)}</span>
                    </span>
                  </div>
                  <Bar pct={pct} tone={pct >= 100 ? "amber" : "brand"} />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* --- Desglose por promotor -------------------------------------- */}
      {report.by_promoter?.length > 0 && (
        <div className="card stagger p-5" style={{ "--i": 8 }}>
          <p className="eyebrow">Por promotor</p>
          <ul className="mt-4 space-y-3.5">
            {report.by_promoter.map((p) => {
              const pct = p.capacity > 0 ? Math.min((p.issued / p.capacity) * 100, 100) : 0;
              return (
                <li key={p.promoter_id}>
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="truncate text-sm font-medium text-slate-300">
                      {p.full_name}
                    </span>
                    <span className="tnum shrink-0 font-mono text-xs text-slate-500">
                      {p.issued}/{p.capacity} cupos · {p.redeemed} en puerta
                      {p.voided > 0 && (
                        <span className="text-red-400"> · {p.voided} anuladas</span>
                      )}
                    </span>
                  </div>
                  <Bar
                    pct={pct}
                    tone={pct >= 100 ? "red" : "brand"}
                    gradient="from-brand-500 to-accent-500"
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Cifra secundaria con un filo de color: lee como estado, no como caja. */
function MiniStat({ label, value, tone }) {
  const tones = {
    emerald: "text-emerald-300 border-emerald-500/20",
    amber: "text-amber-300 border-amber-500/20",
    red: "text-red-300 border-red-500/20",
  };
  return (
    <div className={`rounded-lg border bg-slate-900/40 px-3 py-2.5 ${tones[tone]}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className="tnum mt-1 font-display text-2xl font-extrabold">{value}</p>
    </div>
  );
}