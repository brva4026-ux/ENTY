import { useEffect, useRef, useState } from "react";
import { timeAgo } from "../lib/useLiveRefresh";

/** Marca Tickelot: logotipo, indicadores vivos y cifras animadas. */

export function Logo({ size = "md", animated = true }) {
  const hero = size === "hero";
  const box = hero
    ? "h-16 w-16"
    : size === "xl"
      ? "h-14 w-14"
      : size === "lg"
        ? "h-12 w-12"
        : "h-8 w-8";
  const text =
    size === "xl"
      ? "text-[2.6rem]"
      : size === "lg"
        ? "text-[1.9rem]"
        : "text-[15px]";
  const radius =
    size === "md"
      ? "rounded-[0.55rem]"
      : hero
        ? "rounded-[1.1rem]"
        : "rounded-[0.9rem]";
  return (
    <span className="inline-flex items-center gap-3">
      {/* Isotipo (v3): tile plano del azul acento — cero gradiente, cero
          glow, cero sombra. El troquel de la boleta basta como firma. */}
      <span
        className={`${box} relative ${animated ? "logo-pop" : ""} grid place-items-center`}
      >
        <span
          className={`relative grid h-full w-full place-items-center overflow-hidden ${radius}`}
          style={{
            // Navy del logo (no es azul de marca: es la tinta de la boleta).
            background:
              "linear-gradient(165deg, #243a7a 0%, #16255c 42%, #0b1638 100%)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            className="relative h-[62%] w-[62%]"
            fill="none"
            aria-hidden="true"
          >
            {/* Boleta troquelada en crema: la silueta del logo */}
            <path
              d="M4.4 7.2A2.4 2.4 0 0 1 6.8 4.8h10.4a2.4 2.4 0 0 1 2.4 2.4v1.9a2.7 2.7 0 0 0 0 5.4v1.9a2.4 2.4 0 0 1-2.4 2.4H6.8a2.4 2.4 0 0 1-2.4-2.4v-1.9a2.7 2.7 0 0 0 0-5.4V7.2Z"
              fill="#f5e6c8"
            />
            {/* El ojo que te mira, en tinta */}
            <path
              d="M7.9 11.7c1.1-1.5 2.6-2.2 4.1-2.2s3 .7 4.1 2.2c-1.1 1.5-2.6 2.2-4.1 2.2s-3-.7-4.1-2.2Z"
              fill="#0b1638"
            />
            <circle cx="12" cy="11.7" r="1.35" fill="#f97316" />
            <circle cx="12" cy="11.7" r="0.5" fill="#0b1638" />
            {/* Cuernos de la llama */}
            <path
              d="M8.5 8.3C7.6 7.1 7.9 5.5 9.1 4.5c.5 1.3.6 2.4.2 3.8H8.5Z"
              fill="#f97316"
            />
            <path
              d="M15.5 8.3c.9-1.2.6-2.8-.6-3.8-.5 1.3-.6 2.4-.2 3.8h.8Z"
              fill="#f97316"
            />
            {/* Brasa del talon */}
            <circle cx="15.5" cy="15.3" r="0.7" fill="#ef4444" />
          </svg>
        </span>
      </span>
      {hero ? (
        /* Wordmark hero (v3): tipografía pura, sin píldora ni degradados.
           "Flow" en el azul acento — el único color interactivo del sistema. */
        <span className="brand-chip animate-fade">
          {/* Wordmark hero: Shrikhand (display jugosa del ticket) con el
              sufijo en el azul acento — la misma voz del boleto. */}
          <span
            className="leading-none"
            style={{
              fontFamily: "'Shrikhand', Georgia, serif",
              fontSize: "2.1rem",
              letterSpacing: "0.01em",
            }}
          >
            <span className="brand-shine">Tick</span>
            <span style={{ color: "#f97316" }}>elot</span>
          </span>
        </span>
      ) : (
        <span
          className={`${text} brand-shine leading-none`}
          style={{ fontFamily: "'Shrikhand', Georgia, serif" }}
        >
          Tickelot
        </span>
      )}
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
  draft: {
    badge: "bg-zinc-800/80 text-zinc-400",
    dot: "bg-zinc-500",
    label: "Borrador",
  },
  published: {
    badge: "bg-sky-950/80 text-sky-400",
    dot: "bg-sky-400",
    label: "Publicado",
  },
  live: {
    badge: "bg-emerald-950/80 text-emerald-400",
    dot: "bg-emerald-400",
    label: "En puerta",
  },
  ended: {
    badge: "bg-zinc-800/60 text-zinc-500",
    dot: "bg-zinc-600",
    label: "Finalizado",
  },
  cancelled: {
    badge: "bg-red-950/80 text-red-400",
    dot: "bg-red-500",
    label: "Cancelado",
  },
};

export function EventStatusBadge({ status }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.draft;
  return (
    <span className={`badge ${s.badge}`}>
      <span
        className={`badge-dot ${s.dot} ${status === "live" ? "live-dot" : ""}`}
      />
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
      title={
        lastUpdated
          ? `Última actualización: ${lastUpdated.toLocaleTimeString("es-CO")}`
          : undefined
      }
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
  const fill =
    pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-brand-600";
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
      {full && (
        <p className="mt-1 text-[11px] font-medium text-red-400">
          Cupo agotado
        </p>
      )}
    </>
  );
  return compact ? (
    body
  ) : (
    <div className="rounded-lg bg-zinc-900/60 p-3">{body}</div>
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
