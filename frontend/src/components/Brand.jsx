import { useEffect, useRef, useState } from "react";
import { timeAgo } from "../lib/useLiveRefresh";

/** Marca Enty: logotipo, indicadores vivos y cifras animadas. */

/**
 * Destello de marca: estrella de cuatro puntas asimetrica. Es la firma de
 * Enty y se reutiliza como bullet, indicador de carga y centro del QR.
 */
export function Spark({ size = 12, color = "var(--e-green-500)", className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M12 0.5 L15 9 L23.5 12 L15 15 L12 23.5 L9 15 L0.5 12 L9 9 Z"
        fill={color}
      />
    </svg>
  );
}

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
      ? "text-4xl"
      : size === "lg"
        ? "text-3xl"
        : "text-base";
  const radius =
    size === "md"
      ? "rounded-[0.6rem]"
      : hero
        ? "rounded-[1.15rem]"
        : "rounded-[0.95rem]";
  return (
    <span className="inline-flex items-center gap-3">
      {/* ISOTIPO UNICO. La misma marca que public/icon.svg y que el favicon
          del index.html: icono cuadrado muy redondeado, negro mate con filo
          violeta brillante, la "E" blanca y la estrella de cuatro puntas en
          el lateral derecho. Los colores van planos a proposito — un <defs>
          con id se duplicaria en cada render del Logo y el segundo svg del
          DOM quedaria sin gradiente. */}
      <span
        className={`${box} relative ${animated ? "logo-pop" : ""} grid place-items-center`}
      >
        <span
          className={`brand-tile relative grid h-full w-full place-items-center overflow-hidden ${radius}`}
        >
          <svg
            viewBox="0 0 512 512"
            className="relative h-full w-full"
            aria-hidden="true"
          >
            {/* Filo violeta brillante del tile. */}
            <rect
              x="9"
              y="9"
              width="494"
              height="494"
              rx="118"
              fill="none"
              stroke="var(--e-violet-400)"
              strokeWidth="16"
              strokeOpacity="0.85"
            />
            {/* La "E": asta + tres brazos redondeados. */}
            <g
              stroke="var(--e-white)"
              strokeWidth="60"
              strokeLinecap="round"
              fill="none"
            >
              <path d="M186 156 H318" />
              <path d="M186 256 H292" />
              <path d="M186 356 H318" />
              <path d="M186 156 V356" />
            </g>
            {/* La estrella de cuatro puntas, integrada al lateral derecho. */}
            <path
              fill="var(--e-violet-400)"
              d="M356 196 l13 34 34 13 -34 13 -13 34 -13 -34 -34 -13 34 -13 z"
            />
          </svg>
        </span>
      </span>
      {hero ? (
        /* Wordmark hero: tipografia redondeada y futurista (la voz amable de
           la marca) — "Ent" en tinta blanca y la "y" en el violeta de acento,
           con la estrella de cuatro puntas sobre la "t". */
        <span className="brand-chip animate-fade">
          <span className="brand-wordmark brand-wordmark-hero">
            <span className="brand-shine">En</span>
            <span className="brand-star">
              t
              <svg
                viewBox="0 0 24 24"
                className="brand-star-mark"
                aria-hidden="true"
              >
                <path
                  fill="var(--e-violet-400)"
                  d="M12 1 l2.6 6.8 6.8 2.6 -6.8 2.6 -2.6 6.8 -2.6 -6.8 -6.8 -2.6 6.8 -2.6 z"
                />
              </svg>
            </span>
            <span className="brand-shine">y</span>
          </span>
        </span>
      ) : (
        <span className={`${text} brand-wordmark brand-shine leading-none`}>
          Enty
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
        <p className="mt-1 text-2xs font-medium text-red-400">
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
