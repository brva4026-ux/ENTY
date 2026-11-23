import TransitionLink from "./TransitionLink";
import Icon from "./Icon";
import EventCover, { eventFullDate, eventHook } from "./EventCover";
import { formatEventTime, isPastEvent, isStaleLive, eventZone } from "../lib/eventTime";
import { money } from "../lib/format";

const ACTION = {
  publish: { label: "Publicar", icon: "bolt" },
  live: { label: "Abrir puertas", icon: "door" },
  end: { label: "Finalizar", icon: "flag" },
  reopen: { label: "Reabrir", icon: "undo" },
  cancel: { label: "Cancelar", icon: "close" },
};

function Stat({ label, value, live }) {
  return (
    <span className="admin-event-stat">
      <small>{label}</small>
      <b className={live ? "is-live" : ""}>{value}</b>
    </span>
  );
}

export default function AdminEventCard({
  ev,
  stat,
  actions = [],
  onAction,
  busyAction,
  onOpen,
  onDelete,
  canDelete,
}) {
  const past = isPastEvent(ev);
  const staleLive = isStaleLive(ev);
  const live = ev.status === "live";
  const history =
    ev.status === "ended" ||
    ev.status === "cancelled" ||
    (ev.status === "published" && past);
  const sold = stat?.active ?? null;
  const redeemed = stat?.redeemed ?? null;
  const capacity = ev.capacity ?? 0;
  const pctSold = sold !== null && capacity > 0 ? Math.round((sold / capacity) * 100) : null;
  const pctIn = redeemed !== null && capacity > 0 ? Math.round((redeemed / capacity) * 100) : null;
  const capacityLabel = capacity > 0 ? capacity : "—";
  const tz = eventZone(ev);
  const primaryLabel = live
    ? "Ver puerta"
    : ev.status === "draft"
      ? "Continuar borrador"
      : history
        ? "Ver resumen"
        : "Gestionar evento";
  const primaryTab = live ? "accesos" : "resumen";

  return (
    <article
      className={`admin-event-card evx-card ${live ? "is-live" : ""} ${past && !live ? "is-past" : ""}`}
      data-status={ev.status}
      data-event-id={ev.id}
    >
      <TransitionLink
        to={`/admin?event=${ev.id}&tab=resumen`}
        onClick={onOpen}
        className="admin-card-link"
        aria-label={`Abrir ${ev.name}`}
      />
      <EventCover ev={ev} />

      <div className="admin-event-body">
        <div className="admin-event-topline">
          <span className="admin-state" data-status={ev.status}>
            {live ? "En puerta" : ev.status === "published" ? "A la venta" : ev.status === "draft" ? "Borrador" : ev.status === "ended" ? "Finalizado" : "Cancelado"}
          </span>
          {staleLive && (
            <span className="admin-warning">
              <Icon name="alert" className="h-2.5 w-2.5" />
              Evento pasado · puerta abierta
            </span>
          )}
          {!staleLive && past && ev.status === "published" && (
            <span className="admin-warning">Fecha pasada</span>
          )}
        </div>

        <h3 className="admin-event-title">{ev.name}</h3>
        {eventHook(ev) && <p className="admin-event-hook">{eventHook(ev)}</p>}

        <p className="admin-event-meta">
          <span>
            <Icon name="ticket" className="h-3 w-3" />
            {ev.category || "Sin categoría"}
          </span>
          <span>
            <Icon name="calendar" className="h-3 w-3" />
            {eventFullDate(ev)}
          </span>
          <span>
            <Icon name="clock" className="h-3 w-3" />
            {formatEventTime(ev.starts_at, tz)}
          </span>
          <span>
            <Icon name="door" className="h-3 w-3" />
            {ev.location || "Lugar por confirmar"}
          </span>
        </p>

        <div className="admin-event-stats">
          <Stat label="Recaudo" value={stat ? money(stat.revenue_cents) : "…"} />
          {live ? (
            <>
              <Stat
                label="Ingresaron"
                value={
                  redeemed !== null ? (
                    <>
                      {redeemed}
                      <span className="text-[10px] font-semibold text-[var(--admin-muted)]">
                        /{capacityLabel}
                      </span>
                    </>
                  ) : (
                    "…"
                  )
                }
                live={(redeemed ?? 0) > 0}
              />
              <Stat label="Aforo" value={pctIn !== null ? `${pctIn}%` : "—"} />
            </>
          ) : (
            <>
              <Stat
                label="Vendidas"
                value={
                  sold !== null ? (
                    <>
                      {sold}
                      <span className="text-[10px] font-semibold text-[var(--admin-muted)]">
                        /{capacityLabel}
                      </span>
                    </>
                  ) : (
                    "…"
                  )
                }
              />
              <Stat label="Entraron" value={redeemed ?? "…"} />
              <Stat label="Aforo" value={pctSold !== null ? `${pctSold}%` : "—"} />
            </>
          )}
          {stat?.duplicates > 0 && (
            <Stat label="Alertas" value={stat.duplicates} />
          )}
        </div>

        <div className="admin-event-actions">
          <TransitionLink
            to={`/admin?event=${ev.id}&tab=${primaryTab}`}
            className={live ? "btn-primary" : "admin-link-action"}
            onClick={onOpen}
          >
            {primaryLabel}
            <Icon name="arrowRight" className="h-3 w-3" />
          </TransitionLink>
          {live && (
            <TransitionLink
              to={`/admin?event=${ev.id}&tab=resumen`}
              className="btn-mini"
              onClick={onOpen}
            >
              Gestionar evento
            </TransitionLink>
          )}
          {!live && ev.status !== "draft" && (
            <TransitionLink
              to={`/admin?event=${ev.id}&tab=accesos`}
              className="btn-mini"
            >
              Ver puerta
            </TransitionLink>
          )}
          {!history &&
            ev.status !== "ended" &&
            ev.status !== "cancelled" &&
            actions
              .filter((a) => !a.danger && (a.action !== "end" || staleLive))
              .map(({ action }) => {
              const meta = ACTION[action] ?? { label: action, icon: "bolt" };
              const busy = busyAction === `${action}-${ev.id}`;
              return (
                <button
                  key={action}
                  type="button"
                  onClick={() => onAction?.(ev, action)}
                  disabled={Boolean(busyAction)}
                  className="btn-mini"
                  data-variant={action === "end" ? "danger" : "brand"}
                >
                  {busy ? "…" : meta.label}
                </button>
              );
            })}
          {canDelete && (
            <button
              type="button"
              onClick={() => onDelete?.(ev)}
              className="btn-mini ml-auto"
              data-variant="danger"
              aria-label={`Eliminar ${ev.name}`}
            >
              <Icon name="trash" className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
