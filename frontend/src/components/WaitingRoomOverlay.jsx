import Icon from "../components/Icon";

/**
 * Pantalla de la sala de espera (mig 055/056).
 *
 * Se muestra ENCIMA del checkout cuando el evento tiene la sala activa y el
 * fan todavía no tiene turno. No es una página aparte: es una capa dentro del
 * detalle del evento, porque el fan ya eligió comprar y sacarlo de la ficha
 * sería un paso atrás.
 *
 * Lo importante de la pantalla es que el fan vea que la fila AVANZA: posición
 * real, personas delante y cuántas entran por tanda. Una espera sin números
 * se siente rota y la gente recarga o abandona.
 */
export default function WaitingRoomOverlay({
  state,
  position,
  eventName,
  onRetry,
  onLeave,
}) {
  const waiting = state === "waiting";
  const joining = state === "joining";
  const failed = state === "error";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wr-title"
    >
      <div className="card card-interactive w-full max-w-sm animate-rise p-6 text-center">
        <span className="tile mx-auto mb-4 grid h-12 w-12">
          <Icon
            name={failed ? "alert" : "users"}
            className={`h-5 w-5 ${failed ? "text-red-300" : "text-brand-400"}`}
          />
        </span>

        <h2 id="wr-title" className="text-base font-bold text-ink">
          {failed
            ? "No pudimos conectarte a la fila"
            : joining
              ? "Entrando a la fila"
              : "Estás en la fila"}
        </h2>

        <p className="mt-2 text-xs leading-relaxed text-zinc-400">
          {failed
            ? "Revisa tu conexión y vuelve a intentar. Tu lugar no se pierde."
            : joining
              ? "Un momento: te estamos ubicando en la sala."
              : `Hay mucha gente comprando para ${eventName || "este evento"}. Te avisamos aquí mismo cuando sea tu turno.`}
        </p>

        {waiting && (
          <>
            <div className="mt-5 rounded-xl bg-zinc-900/60 p-4 ring-1 ring-zinc-700">
              <p className="text-2xs uppercase tracking-wider text-zinc-500">
                Personas delante de ti
              </p>
              <p className="tnum mt-1 text-3xl font-bold text-ink">
                {position ?? "—"}
              </p>
            </div>
            <p className="mt-3 text-2xs text-zinc-500">
              La fila avanza sola. Puedes dejar esta pestaña abierta.
            </p>
          </>
        )}

        {joining && (
          <div className="mt-5 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-brand-500" />
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2">
          {failed && (
            <button type="button" onClick={onRetry} className="btn-primary w-full">
              Reintentar
            </button>
          )}
          <button
            type="button"
            onClick={onLeave}
            className="btn-mini w-full text-zinc-400"
          >
            Salir de la fila
          </button>
        </div>
      </div>
    </div>
  );
}
