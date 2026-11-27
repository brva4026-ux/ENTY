import TransitionLink from "./TransitionLink";
import Icon from "./Icon";
import EventCover, { eventFullDate } from "./EventCover";
import ActionMenu from "./ActionMenu";
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
  const tz = eventZone(ev);
  const primaryLabel = ev.status === "draft" ? "Continuar borrador" : "Abrir evento";
  const menu = history ? [] : actions
    .filter((item) => !item.danger && (item.action !== "end" || staleLive))
    .map(({ action }) => ({
      key: action,
      ...(ACTION[action] ?? { label: action, icon: "bolt" }),
      onClick: () => onAction(ev, action),
    }));

  if (canDelete) {
    menu.push({ key: "delete", label: "Eliminar evento", icon: "trash", danger: true, onClick: () => onDelete(ev) });
  }
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
      <EventCover ev={ev} showDate={false} showTime={false} />

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

        <p className="admin-event-meta">
          <span><Icon name="calendar" aria-hidden="true" /><time dateTime={ev.starts_at}>{eventFullDate(ev)}{ev.starts_at && ` · ${formatEventTime(ev.starts_at, tz)}`}</time></span>
          <span><Icon name="pin" aria-hidden="true" />{ev.location || ev.venue_name || "Lugar por confirmar"}</span>
        </p>

        <div className="admin-event-stats">
          {ev.status === "draft" ? (
            <Stat label="Aforo" value={ev.capacity ?? "—"} />
          ) : (
            <>
              <Stat label={live ? "Ingresos" : "Boletas"} value={(live ? stat?.redeemed : stat?.active) ?? "—"} live={live} />
              <Stat label="Recaudo" value={stat ? money(stat.revenue_cents) : "—"} />
              {live && stat?.duplicates > 0 && <Stat label="Alertas" value={stat.duplicates} />}
            </>
          )}
        </div>

        <div className="admin-event-card-footer">
          <span className="admin-event-card-open" aria-hidden="true">
            {primaryLabel}<Icon name="arrowRight" className="h-4 w-4" />
          </span>
          <ActionMenu className="admin-event-card-menu" label={`Acciones de ${ev.name}`} items={menu} busy={Boolean(busyAction)} />
        </div>
      </div>
    </article>
  );
}
