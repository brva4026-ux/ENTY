/* EventWorkbench — ficha de UN evento.
 *
 * La ficha conserva la URL compartible `/admin?event=<id>&tab=<sección>`.
 * Las secciones del rediseño: Resumen, Rentabilidad, Ventas, Equipo,
 * Accesos, Acreditaciones y Sesiones. Las pestañas viejas (Lineup, Boletas, Cupones, Cupos, Noche,
 * Entradas) se normalizan en AdminDashboard para no romper enlaces.
 */
import { useEffect, useRef, useState } from "react";
import { useTabKeys } from "../lib/useTabKeys";
import { LiveIndicator } from "./Brand";
import ActionMenu from "./ActionMenu";
import EmptyState from "./EmptyState";
import Icon from "./Icon";
import TransitionLink from "./TransitionLink";
import EventCover, { eventFullDate } from "./EventCover";
import { formatEventDate, formatEventTime, isStaleLive, eventZone } from "../lib/eventTime";

/* Etiqueta y color por estado — compartidos con la franja de eventos. */
export const STATUS_META = {
  draft: {
    label: "Borrador",
    cls: "bg-zinc-800 text-zinc-300 ring-zinc-600/50",
  },
  published: {
    label: "Publicado",
    cls: "bg-brand-500/15 text-brand-300 ring-brand-500/40",
  },
  live: {
    label: "En puerta",
    cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
  },
  ended: {
    label: "Finalizado",
    cls: "bg-zinc-800 text-zinc-400 ring-zinc-700",
  },
  cancelled: {
    label: "Cancelado",
    cls: "bg-red-500/15 text-red-300 ring-red-500/40",
  },
};

export const STATUS_WEIGHT = {
  live: 0,
  published: 1,
  draft: 2,
  ended: 3,
  cancelled: 4,
};

/** Orden de la franja: lo vivo arriba (lo próximo primero), lo pasado al
 * final (lo más reciente primero). */
export function sortEventsForStrip(events) {
  return [...(events || [])].sort((a, b) => {
    const wa = STATUS_WEIGHT[a.status] ?? 3;
    const wb = STATUS_WEIGHT[b.status] ?? 3;
    if (wa !== wb) return wa - wb;
    const ta = new Date(a.starts_at).getTime();
    const tb = new Date(b.starts_at).getTime();
    return wa >= 3 ? tb - ta : ta - tb;
  });
}

const TABS = [
  { id: "resumen", label: "Resumen", icon: "chart" },
  { id: "rentabilidad", label: "Rentabilidad", icon: "money" },
  { id: "ventas", label: "Ventas", icon: "ticket" },
  { id: "equipo", label: "Equipo", icon: "users" },
  { id: "accesos", label: "Accesos", icon: "door" },
  { id: "operacion", label: "Operación", icon: "chart" },
  { id: "acreditaciones", label: "Acreditaciones", icon: "shield" },
  { id: "sesiones", label: "Sesiones", icon: "calendar" },
];

function endDateLabel(ev, tz) {
  if (!ev.ends_at) return "Sin hora de cierre";
  return formatEventDate(ev.ends_at, tz, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function EventWorkbench({
  ev,
  tab,
  onTab,
  actions = [],
  onAction,
  busyAction,
  isLive,
  lastUpdated,
  onEdit,
  editable,
  onDelete,
  onDuplicate,
  canDelete = false,
  onExit,
}) {
  const tabsRef = useRef(null);
  const [now, setNow] = useState(Date.now());
  const wbTabs = useTabKeys({
    ids: TABS.map((t) => t.id),
    activeId: tab,
    onSelect: onTab,
    idOf: (id) => `evx-tab-${id}`,
  });

  useEffect(() => {
    const active = tabsRef.current?.querySelector('[aria-selected="true"]');
    active?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [tab]);

  useEffect(() => {
    if (!ev || (ev.status !== "draft" && ev.status !== "published")) {
      return undefined;
    }
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [ev]);

  if (!ev) return null;
  const status = STATUS_META[ev.status] ?? STATUS_META.draft;
  const staleLive = isStaleLive(ev);
  const tz = eventZone(ev);
  const startMs = new Date(ev.starts_at).getTime();
  const diff = startMs - now;
  let countdown = null;
  if (ev.status === "live") {
    countdown = `En puerta desde ${formatEventTime(ev.starts_at, tz)}`;
  } else if (ev.status === "ended") {
    countdown = "La noche ya cerró";
  } else if (ev.status === "cancelled") {
    countdown = "Evento cancelado";
  } else if (diff <= 0) {
    countdown = "La hora de inicio ya pasó";
  } else if (diff < 60 * 60 * 1000) {
    countdown = `Comienza en ${Math.max(1, Math.ceil(diff / 60_000))} min`;
  } else if (diff < 24 * 60 * 60 * 1000) {
    countdown = `Comienza en ${Math.ceil(diff / 3_600_000)} h`;
  } else if (diff < 48 * 60 * 60 * 1000) {
    countdown = "Comienza mañana";
  }
  const primaryActions = actions.filter((a) => !a.danger && !a.secondary);
  const secondaryActions = actions.filter((a) => !a.danger && a.secondary);
  const cancelAction = actions.find((a) => a.action === "cancel");
  const menuItems = [
    ...(editable
      ? [{ key: "edit", label: "Editar evento", icon: "edit", onClick: onEdit }]
      : []),
    ...(onDuplicate
      ? [{ key: "duplicate", label: "Duplicar evento", icon: "copy", onClick: onDuplicate }]
      : []),
    ...(cancelAction
      ? [{
          key: "cancel",
          label: "Cancelar evento",
          icon: "close",
          danger: true,
          disabled: busyAction === "cancel",
          onClick: () => onAction("cancel"),
        }]
      : []),
    ...(canDelete && ev.status !== "live"
      ? [{
          key: "delete",
          label: "Eliminar evento",
          icon: "trash",
          danger: true,
          onClick: onDelete,
        }]
      : []),
  ];

  return (
    <div className="bs-shell">
      <section className="bs-head" data-tour="backstage">
        <div className="bs-poster">
          <EventCover ev={ev} showTime={false} />
        </div>

        <div className="bs-ident">
          <div className="bs-title-row">
            <div className="bs-title-block">
              <p className="bs-kicker">Backstage del evento</p>
              <h1 className="bs-title">{ev.name}</h1>
              <div className="bs-status-row">
                <span className="bs-status" data-status={ev.status}>
                  <span className="bs-status-dot" aria-hidden="true" />
                  {status.label}
                </span>
                {staleLive && (
                  <span className="bs-warning">
                    <Icon name="alert" className="h-3.5 w-3.5" aria-hidden="true" />
                    Evento pasado · puerta abierta
                  </span>
                )}
                {countdown && (
                  <span className="bs-countdown">
                    <Icon name="clock" className="h-3.5 w-3.5" aria-hidden="true" />
                    {countdown}
                  </span>
                )}
              </div>
            </div>

            <div className="bs-head-actions">
              <button
                type="button"
                onClick={onExit}
                className="bs-back"
                aria-label="Volver a Eventos"
              >
                <Icon name="back" className="h-4 w-4" aria-hidden="true" />
                <span className="bs-back-label">Volver a Eventos</span>
              </button>
              {menuItems.length > 0 && (
                <ActionMenu label={`Opciones de ${ev.name}`} items={menuItems} />
              )}
            </div>
          </div>

          <dl className="bs-facts">
            <div>
              <dt>Inicio</dt>
              <dd>
                <strong>{eventFullDate(ev)}</strong>
                <span>{formatEventTime(ev.starts_at, tz)}</span>
              </dd>
            </div>
            <div>
              <dt>Fin</dt>
              <dd>
                <strong>{endDateLabel(ev, tz)}</strong>
                <span>
                  {ev.ends_at ? formatEventTime(ev.ends_at, tz) : "Por confirmar"}
                </span>
              </dd>
            </div>
            <div>
              <dt>Lugar</dt>
              <dd>
                <strong>{ev.location || "Lugar por confirmar"}</strong>
                <span>{ev.venue_name || ev.category || "Evento"}</span>
              </dd>
            </div>
          </dl>

          <div className="bs-actions">
            {primaryActions.map(({ action, label }) => (
              <button
                key={action}
                type="button"
                onClick={() => onAction(action)}
                disabled={busyAction === action}
                className="btn-primary bs-primary"
              >
                {busyAction === action ? "Procesando…" : label}
              </button>
            ))}
            {secondaryActions.map(({ action, label }) => (
              <button
                key={action}
                type="button"
                onClick={() => onAction(action)}
                disabled={busyAction === action}
                className="bs-secondary"
              >
                {busyAction === action ? "Procesando…" : label}
              </button>
            ))}
            {editable && (
              <button type="button" onClick={onEdit} className="bs-secondary">
                <Icon name="edit" className="h-4 w-4" aria-hidden="true" />
                Editar evento
              </button>
            )}
            {lastUpdated && (
              <LiveIndicator live={Boolean(isLive)} lastUpdated={lastUpdated} />
            )}
          </div>
        </div>
      </section>

      <nav
        ref={tabsRef}
        className="bs-tabs"
        role="tablist"
        aria-label="Secciones del evento"
        data-tour="tabs-evento"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`evx-tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="evx-tab-panel"
            tabIndex={wbTabs.tabIndexFor(t.id)}
            onKeyDown={wbTabs.onKeyDown}
            onClick={() => onTab(t.id)}
            className="bs-tab"
          >
            <Icon name={t.icon} className="h-4 w-4" aria-hidden="true" />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      <p className="bs-tabs-hint" aria-hidden="true">
        Desliza para ver las siete secciones →
      </p>
    </div>
  );
}

/** Pantalla de evento inexistente, borrado o fuera de la organización. */
export function EventNotFound({ onBack, reason }) {
  return (
    <EmptyState icon="alert" title="Este evento no está disponible">
      {reason ||
        "Puede que el enlace sea viejo, que el evento se haya eliminado o que ya no tengas acceso a esta organización."}
      <span className="mt-3 block">
        <TransitionLink
          to="/admin"
          onClick={() => onBack?.()}
          className="btn-primary inline-block px-4 py-2 text-xs font-bold"
        >
          Volver a Eventos
        </TransitionLink>
      </span>
    </EmptyState>
  );
}
