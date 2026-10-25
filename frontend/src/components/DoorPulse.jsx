/* DoorPulse — el ritmo de la puerta: ingresos por franja de 10 min.
 *
 * El total ("ingresaron 312") dice CÓMO VA la puerta; no dice si está
 * FLUYENDO o ATASCADA. Un hueco de 20 min a las 22:00 con el aforo a la mitad
 * es un problema AHORA, no un número para el CSV de mañana. Esta es la señal
 * con la que un jefe de puerta decide abrir otro lector.
 *
 * Solo ingresos (granted): el ritmo es flujo de gente, no de intentos. La
 * franja vacía ES el dato, por eso el backend rellena los huecos con 0 y aquí
 * se dibujan como columnas de altura cero.
 */
import Icon from "./Icon";

export default function DoorPulse({ pulse, isLive }) {
  const bars = pulse || [];
  const total = bars.reduce((n, b) => n + b.count, 0);
  const max = Math.max(1, ...bars.map((b) => b.count));
  const peak = bars.reduce(
    (best, b) => (b.count > best.count ? b : best),
    bars[0] ?? { count: 0 },
  );
  const last = bars[bars.length - 1];

  return (
    <div className="card dp-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div>
          <p className="eyebrow">Puerta</p>
          <h3 className="display mt-0.5 text-lg">Ritmo de la noche</h3>
        </div>
        {bars.length > 0 && (
          <p className="tnum text-xs text-zinc-500">
            pico{" "}
            <span className="font-semibold text-zinc-200">{peak.count}</span> a
            las <span className="text-zinc-300">{peak.label}</span>
          </p>
        )}
      </div>

      {bars.length === 0 ? (
        <div className="dp-empty">
          <Icon name="door" className="h-4 w-4" aria-hidden="true" />
          <span>
            Aún no entra nadie. En cuanto el primer QR pase, verás aquí el pulso
            de la puerta franja a franja.
          </span>
        </div>
      ) : (
        <>
          <div
            className="dp-chart no-scrollbar"
            role="img"
            aria-label={`Ingresos por franja de 10 minutos: ${total} en total, pico de ${peak.count} a las ${peak.label}`}
          >
            {bars.map((b, i) => {
              const isLast = i === bars.length - 1;
              return (
                <div key={b.bucket} className="dp-col">
                  {b.count > 0 && <span className="dp-num tnum">{b.count}</span>}
                  <div
                    className={`dp-bar ${isLast && isLive ? "is-now" : ""}`}
                    style={{ height: `${Math.max(3, (b.count / max) * 82)}%` }}
                    title={`${b.label} · ${b.count} ${b.count === 1 ? "ingreso" : "ingresos"}`}
                  />
                  <span className="dp-tick tnum">
                    {i % Math.ceil(bars.length / 6) === 0 ? b.label : ""}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span>
              <span className="tnum font-semibold text-zinc-300">{total}</span>{" "}
              ingresos en {bars.length} franja{bars.length === 1 ? "" : "s"}
            </span>
            <span className="text-zinc-600">·</span>
            <span>último ingreso {last.label}</span>
            {isLive && (
              <>
                <span className="text-zinc-600">·</span>
                <span className="inline-flex items-center gap-1 text-emerald-300">
                  <span className="dp-live-dot" aria-hidden="true" />
                  en vivo
                </span>
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}
