/**
 * Anillo de aforo. El arco se dibuja con `stroke-dasharray`, de modo que el
 * progreso es una sola transicion CSS y no un redibujado de la ruta.
 * El color comunica presion: holgado, apretado, lleno.
 */
const SIZE = 132;
const STROKE = 10;
const R = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * R;
/** El arco util es 3/4 de vuelta: deja un hueco abajo que le da tension. */
const SWEEP = 0.75;

export default function OccupancyRing({ pct = 0, used = 0, total = 0, live = false }) {
  const clamped = Math.max(0, Math.min(pct, 100));
  const arc = CIRC * SWEEP;

  const stroke =
    clamped >= 95
      ? "#f87171"
      : clamped >= 80
        ? "#fbbf24"
        : live
          ? "#34d399"
          : "#3e6ae1";

  return (
    <div className="relative grid place-items-center" style={{ width: SIZE, height: SIZE }}>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="-rotate-[135deg]"
        aria-hidden="true"
      >
        {/* Riel: marca hasta donde llega el arco util. */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="rgba(148,163,184,0.14)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${CIRC}`}
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke={stroke}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${(arc * clamped) / 100} ${CIRC}`}
          style={{
            transition: "stroke-dasharray 900ms cubic-bezier(0.22,1,0.36,1), stroke 400ms",
            filter: `drop-shadow(0 0 10px ${stroke}55)`,
          }}
        />
      </svg>

      <div className="absolute inset-0 grid place-content-center text-center">
        <div
          className={`tnum font-display text-4xl font-extrabold leading-none text-white ${
            live ? "breathe" : ""
          }`}
        >
          {clamped.toFixed(0)}
          <span className="text-xl font-bold text-slate-400">%</span>
        </div>
        <div className="tnum mt-1 text-[11px] font-semibold text-slate-500">
          {used} / {total}
        </div>
      </div>
    </div>
  );
}