import { useEffect, useRef, useState } from "react";
import { timeAgo } from "../lib/useLiveRefresh";

/** Marca V-Pass: logotipo, indicadores vivos y cifras animadas.

 * Isotipo único: la mano en señal de paz sobre las ondas del agua, con las
 * llamas encendidas en los dedos y el nombre escrito sobre la marca.
 * Se reutiliza como miniatura, indicador de carga y centro del QR.
 */

/** Marcador de marca: la mano + las ondas + las llamas, en tinta negra
 *  sobre un fondo parchment, a cualquier tamaño. El nombre está grabado
 *  dentro de la imagen, como el de un pegatina. */
export function LogoMark({ size = "md", className = "" }) {
  const box =
    size === "lg"
      ? "h-16 w-16"
      : size === "md"
        ? "h-12 w-12"
        : size === "sm"
          ? "h-8 w-8"
          : "h-6 w-6";
  return (
    <span
      className={`relative ${className}`}
      style={{ display: "inline-flex" }}
    >
      <span
        className={`brand-tile relative grid h-full w-full place-items-center overflow-hidden ${box}`}
      >
        <svg
          viewBox="0 0 512 512"
          className="relative h-full w-full"
          role="img"
          aria-label="CELESTIAL STROKES"
        >
          <defs>
            <linearGradient id="cs-parchment" x1="0" y1="0" x2="512" y2="512">
              <stop offset="0" stopColor="#FAF9F6" />
              <stop offset="1" stopColor="#E8E6DF" />
            </linearGradient>
            <linearGradient id="cs-water" x1="0" y1="0" x2="0" y2="512">
              <stop offset="0" stopColor="#4A90E2" />
              <stop offset="1" stopColor="#2C5AA0" />
            </linearGradient>
            <linearGradient
              id="cs-peace"
              x1="0"
              y1="0"
              x2="512"
              y2="512"
            >
              <stop offset="0" stopColor="#FFD700" />
              <stop offset="1" stopColor="#FF6B6B" />
            </linearGradient>
          </defs>

          {/* Fondo parchment */}
          <rect
            width="512"
            height="512"
            rx="118"
            fill="url(#cs-parchment)"
          />

          {/* Ondas concéntricas del agua */}
          <g fill="none" stroke="rgba(44, 90, 160, 0.35)" strokeWidth="1">
            <circle cx="256" cy="380" r="80" />
            <circle cx="256" cy="380" r="60" />
            <circle cx="256" cy="380" r="40" />
            <circle cx="256" cy="380" r="20" />
          </g>

          {/* Mano: antebrazo + dedos en señal de paz */}
          <g stroke="#1A1A1A" strokeWidth="3.2" strokeLinecap="round" fill="none">
            <path d="M256 360 Q256 336 256 316" />
            <path d="M240 274 C230 256 218 244 206 258 Q194 272 190 288" />
            <path d="M272 274 C282 256 292 244 304 258 Q314 272 318 288" />
            <path d="M256 316 Q256 292 260 282" />
            <path d="M256 316 Q256 292 252 282" />
          </g>

          {/* Puntos y lunares de la mano */}
          <circle cx="230" cy="258" r="4.5" fill="#FF6B6B" />
          <circle cx="270" cy="258" r="4.5" fill="#FF6B6B" />
          <path
            d="M208 246 Q196 236 192 226"
            stroke="#FFD700"
            strokeWidth="2"
            fill="none"
          />
          <path
            d="M306 258 Q316 248 318 240"
            stroke="#FFD700"
            strokeWidth="2"
            fill="none"
          />

          {/* Llamas de los dos dedos extendidos */}
          <g fill="none" stroke="url(#cs-peace)" strokeWidth="4" strokeLinecap="round">
            <path d="M204 250 C196 232 188 218 186 206" />
            <path d="M210 262 C218 246 230 232 240 220" />
          </g>
          <g fill="#FFD700">
            <circle cx="188" cy="200" r="3" />
            <circle cx="244" cy="214" r="3" />
          </g>

          {/* Texto del nombre */}
          <text
            x="256"
            y="186"
            textAnchor="middle"
            fontFamily="Georgia, serif"
            fontSize="42"
            fontWeight="bold"
            fill="#1A1A1A"
          >
            V-PASS
          </text>

          {/* Subtítulo */}
          <text
            x="256"
            y="236"
            textAnchor="middle"
            fontFamily="Apple Garamond, Baskerville, serif"
            fontSize="19"
            fill="#6B6B6B"
          >
            La mano señal de paz, la llama que arde
          
          </text>

          {/* Firma Ray */}
          <text
            x="460"
            y="490"
            textAnchor="end"
            fontFamily="Segoe Script, cursive"
            fontSize="17"
            fill="#4A90E2"
          >
            V-Pass.
          </text>
        </svg>
      </span>
    </span>
  );
}

/** Palabra de marca: "V-PASS" en tipografía redondeada y
 *  finita (la voz amable de la marca). */
export function Wordmark({
  size = "md",
  className = "",
  animated = true,
}) {
  const sm = size === "sm";
  const md = size === "md";
  const lg = size === "lg";
  const display =
    lg ||
    (md && !sm) ||
    (sm && !md);
  return (
    <span
      className={`brand-wordmark inline-flex items-center leading-none tracking-wide ${className} ${
        animated ? "animate-fade" : ""
      }`}
      style={
        {
          fontSize:
            lg || md
              ? "1.45rem"
              : sm
                ? "1rem"
                : "1.2rem",
          letterSpacing: "0.06em",
        } as React.CSSProperties
      }
    >
      <svg
        viewBox="0 0 512 512"
        className={`brand-star-mark relative inline-block align-middle ${sm ? "h-6 w-6" : "h-8 w-8"}`}
        aria-hidden="true"
      >
        <path
          fill="#BB5CF6"
          d="M356 196 l13 34 34 13 -34 13 -13 34 -13 -34 -34 -13 34 -13 z"
        />
      </svg>
      <span className="uppercase tracking-[0.22em] text-zinc-900">
        V-PASS
      </span>
    </span>
  );
}

/** Logotipo completo: marcador + palabra de marca. */
export function Logo({
  size = "md",
  animated = true,
  showWordmark = true,
}) {
  const box =
    size === "xl"
      ? "h-16 w-16"
      : size === "lg"
        ? "h-12 w-12"
        : size === "md"
          ? "h-8 w-8"
          : "h-6 w-6";
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
