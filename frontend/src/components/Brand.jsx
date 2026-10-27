import { useEffect, useId, useRef, useState } from "react";
import { timeAgo } from "../lib/useLiveRefresh";
import { BADGE, SPARK, V_PATH, V_WIDTH, VIEWBOX, sparkPath } from "../lib/brandMark";

/** Marca V-Pass: isotipo vectorial, indicadores vivos y cifras animadas.

 * El isotipo es la "V" luminosa sobre una placa de carbón, con el destello de
 * la marca arriba a la derecha. Vectorial: se ve igual de filoso a 16px
 * (favicon) que a 512px (icono de app), y hereda el glow del tema. Antes era
 * un JPEG de 1.8 MB que se recortaba mal en el tile cuadrado.
 */

/** Destello de marca: estrella de cuatro puntas asimetrica. Se reutiliza como
 *  bullet, indicador de carga y centro del QR. */
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

/** Isotipo vectorial: la "V" luminosa sobre la placa de carbón, con destello.
 *  Los ids de gradiente llevan un sufijo unico por instancia para que varias
 *  copias en la misma pagina no se pisen. */
export function MarkGlyph({ className = "" }) {
  const uid = useId().replace(/:/g, "");
  return (
    <svg
      viewBox={VIEWBOX}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${uid}-badge`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--e-mark-badge-top)" />
          <stop offset="1" stopColor="var(--e-mark-badge-bottom)" />
        </linearGradient>
        <linearGradient id={`${uid}-v`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="var(--e-mark-v-top)" />
          <stop offset="1" stopColor="var(--e-mark-v-bottom)" />
        </linearGradient>
      </defs>
      <rect
        x={BADGE.x}
        y={BADGE.y}
        width={BADGE.w}
        height={BADGE.h}
        rx={BADGE.r}
        fill={`url(#${uid}-badge)`}
      />
      <rect
        x={BADGE.x}
        y={BADGE.y}
        width={BADGE.w}
        height={BADGE.h}
        rx={BADGE.r}
        fill="none"
        stroke="var(--e-mark-ring)"
        strokeOpacity="0.45"
        strokeWidth="1.5"
      />
      <path
        d={V_PATH}
        fill="none"
        stroke={`url(#${uid}-v)`}
        strokeWidth={V_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d={sparkPath(SPARK)} fill="var(--e-mark-spark)" />
    </svg>
  );
}

/** Marcador de marca: el isotipo en un tile con glow, filo de neón y un
 *  destello que barre al entrar. Es el elemento "vivo" de la cabecera. */
export function LogoMark({ size = "md", className = "" }) {
  const box =
    size === "hero"
      ? "h-24 w-24"
      : size === "xl"
        ? "h-16 w-16"
        : size === "lg"
          ? "h-12 w-12"
          : size === "md"
            ? "h-8 w-8"
            : "h-6 w-6";
  return (
    <span
      className={`relative brand-tile grid shrink-0 place-items-center overflow-hidden rounded-lg ${box} ${className}`}
    >
      <MarkGlyph className="h-full w-full" />
    </span>
  );
}

/** Palabra de marca: "V-PASS" en tipografía sans, mayúsculas y espaciada.
 *  Provisional: la imagen de marca no trae texto, así que el nombre se
 *  escribe aparte junto al marcador. */
export function Wordmark({ size = "md", className = "", animated = true }) {
  const fontSize =
    size === "hero" || size === "xl" || size === "lg"
      ? "1.45rem"
      : size === "sm"
        ? "1rem"
        : "1.2rem";
  return (
    <span
      className={`brand-wordmark inline-flex items-center leading-none ${className} ${
        animated ? "animate-fade" : ""
      }`}
      style={{ fontSize, letterSpacing: "0.06em" }}
    >
      <span className="font-semibold uppercase tracking-[0.22em]">V-PASS</span>
    </span>
  );
}

/** Logotipo completo: marcador + palabra de marca. */
export function Logo({ size = "md", animated = true, showWordmark = true }) {
  return (
    <span className="inline-flex items-center gap-3">
      <LogoMark size={size} />
      {showWordmark && <Wordmark size={size} animated={animated} />}
    </span>
  );
}

/** Cifra que cuenta desde su valor anterior hasta el nuevo
 *  (easing expo). `format` recibe el número interpolado (para moneda,
 *  %, etc.). Con prefers-reduced-motion pinta el valor sin animar.
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
