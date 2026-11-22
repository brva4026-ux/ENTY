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

/** Símbolo Enty: boleto sólido inclinado, con muescas semicirculares.
 *
 * Es la pieza única de la marca. No lleva letras, perforaciones ni degradados:
 * la forma tiene que leerse a 16 px (favicon) y a 240 px (portada). El trazo
 * sigue la especificación de 48×48 y se rota −25° alrededor del centro.
 */
export function EntySymbol({ size = 32, className = "", title }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={`enty-symbol-svg ${className}`}
      {...(title
        ? { role: "img", "aria-label": title }
        : { "aria-hidden": "true" })}
    >
      <path
        fill="currentColor"
        d="M7 12H41A3 3 0 0 1 44 15V20A4 4 0 0 0 44 28V33A3 3 0 0 1 41 36H7A3 3 0 0 1 4 33V28A4 4 0 0 0 4 20V15A3 3 0 0 1 7 12Z"
        transform="rotate(-25 24 24)"
      />
    </svg>
  );
}

/** Marca completa: símbolo + «Enty». El color del texto lo hereda del
 *  contenedor (tinta en claro, claro en oscuro); el símbolo conserva el
 *  violeta de Enty. En espacios compactos se puede ocultar el wordmark. */
export function Logo({ size = "md", animated = true, compact = false }) {
  const px =
    size === "hero" ? 64 : size === "xl" ? 52 : size === "lg" ? 44 : 32;
  return (
    <span
      className={`enty-logo ${animated ? "logo-pop" : ""}`}
      aria-label="Enty"
    >
      <span className="enty-logo-mark">
        <EntySymbol size={px} />
      </span>
      {!compact && <span className="enty-logo-word">Enty</span>}
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
        className={`h-full rounded-full transition-[width] duration-700 ${
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
      <div className="tnum mt-1.5 font-display text-3xl font-extrabold leading-none tracking-tight text-ink">
        {value}
      </div>
    </div>
  );
}
