import { useEffect, useId, useRef, useState } from "react";
import { timeAgo } from "../lib/useLiveRefresh";
import { NOTCH, PERF_WIDTH, SIMPLE_BELOW, SPARK, TICKET, V_PATH, V_WIDTH, VIEWBOX, sparkPath } from "../lib/brandMark";

/** Marca V-Pass: isotipo vectorial, indicadores vivos y cifras animadas.

 * El isotipo es la "V" luminosa sobre una placa de carbón, con el destello de
 * la marca arriba a la derecha. Vectorial: se ve igual de filoso a 16px
 * (favicon) que a 512px (icono de app), y hereda el glow del tema. Antes era
 * un JPEG de 1.8 MB que se recortaba mal en el tile cuadrado.
 */

/** Destello de marca: la misma estrella de cuatro puntas del isotipo, en
 *  viewBox 24. Se reutiliza como bullet, indicador de carga y centro del QR.
 *  Sale de sparkPath() para que el bullet no derive del logo: antes llevaba un
 *  path escrito a mano con otra cintura (0.369 frente a 0.32). */
export function Spark({ size = 12, color = "var(--e-green-500)", className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <path d={sparkPath({ cx: 12, cy: 12, r: 11.5, waist: SPARK.waist })} fill={color} />
    </svg>
  );
}

/** Isotipo vectorial: el boleto y su troquel.
 *
 *  Un boleto de papel, con las muescas del boleto real en los bordes laterales,
 *  y un desgarro en V que separa el talon: la marca es como se rompe. El papel
 *  crema (no una placa oscura) es lo que hace que el isotipo se vea entero
 *  sobre el canvas oscuro de la app, a cualquier tamano.
 *
 *  `size` decide el detalle: por debajo de SIMPLE_BELOW el desgarro va macizo,
 *  sin perforacion punteada ni talon tintado, porque a 16px los puntos se funden
 *  en una linea gris (medido, ver brandMark.js). El boleto y su V no cambian. */
export function MarkGlyph({ className = "", size = 0 }) {
  const uid = useId().replace(/:/g, "");
  const conDetalle = size >= SIMPLE_BELOW;
  const ticket = { x: TICKET.x, y: TICKET.y, width: TICKET.w, height: TICKET.h, rx: TICKET.r };
  const talon = `M32 47 L61 32 L61 ${TICKET.y + TICKET.h} L32 ${TICKET.y + TICKET.h} Z`;
  return (
    <svg
      viewBox={VIEWBOX}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${uid}-paper`} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="var(--e-mark-paper-top)" />
          <stop offset="1" stopColor="var(--e-mark-paper-bottom)" />
        </linearGradient>
        <linearGradient id={`${uid}-v`} x1="0.1" y1="0" x2="0.5" y2="1">
          <stop offset="0" stopColor="var(--e-mark-v-top)" />
          <stop offset="0.45" stopColor="var(--e-mark-v-mid)" />
          <stop offset="1" stopColor="var(--e-mark-v-bottom)" />
        </linearGradient>
        <mask id={`${uid}-notch`} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <circle cx={TICKET.x} cy={NOTCH.cy} r={NOTCH.r} fill="#000" />
          <circle cx={TICKET.x + TICKET.w} cy={NOTCH.cy} r={NOTCH.r} fill="#000" />
        </mask>
        <clipPath id={`${uid}-talon`}>
          <path d={talon} />
        </clipPath>
      </defs>
      <rect {...ticket} fill={`url(#${uid}-paper)`} mask={`url(#${uid}-notch)`} />
      {conDetalle && (
        <rect
          {...ticket}
          fill="var(--e-mark-stub)"
          fillOpacity="0.1"
          mask={`url(#${uid}-notch)`}
          clipPath={`url(#${uid}-talon)`}
        />
      )}
      <rect
        {...ticket}
        fill="none"
        stroke="var(--e-mark-edge)"
        strokeOpacity="0.55"
        strokeWidth="1.7"
        mask={`url(#${uid}-notch)`}
      />
      <path
        d={V_PATH}
        fill="none"
        stroke={`url(#${uid}-v)`}
        strokeWidth={V_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {conDetalle && (
        <path
          d={V_PATH}
          fill="none"
          stroke="var(--e-mark-perf)"
          strokeOpacity="0.4"
          strokeWidth={PERF_WIDTH}
          strokeDasharray="3 2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
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
  // El isotipo necesita el tamano en px para decidir si entra el destello.
  const px = { hero: 96, xl: 64, lg: 48, md: 32 }[size] ?? 24;
  return (
    <span
      className={`relative brand-tile grid shrink-0 place-items-center overflow-hidden rounded-lg ${box} ${className}`}
    >
      <MarkGlyph className="h-full w-full" size={px} />
    </span>
  );
}

/** Palabra de marca: "V-PASS" con jerarquía y separador de marca.
 *
 * Antes era texto liso con tracking uniforme y un guion tipográfico, y además
 * tenía dos tracking en conflicto: el componente forzaba 0.22em y el CSS
 * `.brand-wordmark` pedía -0.01em. Ninguno de los dos es correcto para
 * mayúsculas de marca; se midió y se fija uno solo (ver `.brand-wordmark`).
 *
 * La "V" va en tinta de acento y el resto en tinta primaria: el ojo entra por
 * la V, que es la letra del isotipo. El guion tipográfico se sustituye por una
 * barra de marca (`brand-wordmark-sep`), el corte del pase.
 */
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
      style={{ fontSize }}
    >
      <span className="brand-wordmark-v">V</span>
      <span className="brand-wordmark-sep" aria-hidden="true" />
      <span className="brand-wordmark-rest">PASS</span>
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
