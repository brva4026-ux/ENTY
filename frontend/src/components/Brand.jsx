import { useEffect, useRef, useState } from "react";
import { timeAgo } from "../lib/useLiveRefresh";

/** Marca TicketFlow: logotipo, indicadores vivos y cifras animadas. */

export function Logo({ size = "md", animated = true }) {
  const box = size === "lg" ? "h-10 w-10" : "h-7 w-7";
  const text = size === "lg" ? "text-2xl" : "text-[15px]";
  return (
    <span className="inline-flex items-center gap-2">
      {/* Isotipo: ticket minimalista de línea, un solo acento.
          Entrada con resorte (rota y crece) como en apps nativas. */}
      <span
        className={`${box} ${animated ? "logo-pop" : ""} grid place-items-center rounded-[0.55rem] bg-brand-600`}
      >
        <svg viewBox="0 0 24 24" className="h-[58%] w-[58%] text-white" fill="currentColor">
          <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.2a2.8 2.8 0 0 0 0 5.6V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.2a2.8 2.8 0 0 0 0-5.6V7z" />
        </svg>
      </span>
      <span className={`${text} display text-white`}>
        Ticket<span className="text-brand-400">Flow</span>
      </span>
    </span>
  );
}

/**
 * Cifra que cuenta desde su valor anterior hasta el nuevo (easing expo).
 * `format` recibe el número interpolado (para moneda, %, etc.).
 * Con prefers-reduced-motion pinta el valor sin animar.
 */
export function AnimatedNumber({
  value,
  format = (v) => String(v),
  duration = 900,
  className = "",
}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    const target = Number(value) || 0;
    if (target === fromRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 4); // expo-out: rápido al inicio, se asienta
      setDisplay(Math.round(from + (target - from) * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return <span className={className}>{format(display)}</span>;
}

const STATUS_STYLES = {
  draft: { badge: "bg-zinc-800/80 text-zinc-400", dot: "bg-zinc-500", label: "Borrador" },
  published: { badge: "bg-sky-950/80 text-sky-400", dot: "bg-sky-400", label: "Publicado" },
  live: { badge: "bg-emerald-950/80 text-emerald-400", dot: "bg-emerald-400", label: "En puerta" },
  ended: { badge: "bg-zinc-800/60 text-zinc-500", dot: "bg-zinc-600", label: "Finalizado" },
  cancelled: { badge: "bg-red-950/80 text-red-400", dot: "bg-red-500", label: "Cancelado" },
};

export function EventStatusBadge({ status }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.draft;
  return (
    <span className={`badge ${s.badge}`}>
      <span className={`badge-dot ${s.dot} ${status === "live" ? "live-dot" : ""}`} />
      {s.label}
    </span>
  );
}

/** Indicador de auto-actualización: punto pulsante + "hace X s". */
export function LiveIndicator({ live, lastUpdated }) {
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!lastUpdated) return;
    const id = setInterval(() => setNow((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  const label = timeAgo(lastUpdated);
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500"
      title={lastUpdated ? `Última actualización: ${lastUpdated.toLocaleTimeString("es-CO")}` : undefined}
    >
      <span className="relative inline-flex h-1.5 w-1.5">
        {live && <span className="live-ping" />}
        <span
          className={`relative h-1.5 w-1.5 rounded-full ${
            live ? "live-dot" : "bg-zinc-700"
          }`}
        />
      </span>
      {live ? "En vivo" : label || "Sincronizado"}
      {live && label && <span className="tnum">{label}</span>}
    </span>
  );
}

/** Medidor de cupo: sobrio, con estado textual cuando aprieta. */
export function QuotaMeter({ used, total, label, compact = false }) {
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const fill = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-brand-600";
  const full = pct >= 100;
  const body = (
    <>
      <div className="mb-1.5 flex items-baseline justify-between text-xs">
        <span className="text-zinc-500">{label}</span>
        <span className="tnum font-semibold text-zinc-200">
          {used}
          <span className="font-normal text-zinc-500">/{total}</span>
        </span>
      </div>
      <div className="meter">
        <div className={`meter-fill ${fill}`} style={{ width: `${pct}%` }} />
      </div>
      {full && <p className="mt-1 text-[11px] font-medium text-red-400">Cupo agotado</p>}
    </>
  );
  return compact ? body : <div className="rounded-lg bg-zinc-900/60 p-3">{body}</div>;
}
