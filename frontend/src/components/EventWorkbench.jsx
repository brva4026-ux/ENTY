/* EventWorkbench — ficha de UN evento.
 *
 * La ficha conserva la URL compartible `/admin?event=<id>&tab=<sección>`.
 * Las cuatro secciones son las del rediseño: Resumen, Ventas, Equipo y
 * Accesos. Las pestañas viejas (Lineup, Boletas, Cupones, Cupos, Noche,
 * Entradas) se normalizan en AdminDashboard para no romper enlaces.
 */
import { useTabKeys } from "../lib/useTabKeys";
import { LiveIndicator } from "./Brand";
import ActionMenu from "./ActionMenu";
import EmptyState from "./EmptyState";
import Icon from "./Icon";
import TransitionLink from "./TransitionLink";
import EventCover, { eventFullDate } from "./EventCover";
import { formatEventTime, isStaleLive, eventZone } from "../lib/eventTime";

/* Etiqueta y color por estado — compartidos con la franja de eventos. */
export const STATUS_META = {
  draft: {
    label: "Borrador",
    cls: "bg-zinc-800 text-zinc-300 ring-zinc-600/50",
  },
  published: {
    label: "A la venta",
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
  { id: "ventas", label: "Ventas", icon: "ticket" },
  { id: "equipo", label: "Equipo", icon: "users" },
  { id: "accesos", label: "Accesos", icon: "door" },
];

export default function EventWorkbench({
  ev,
  tab,
  onTab,
  actions,
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
  const wbTabs = useTabKeys({
    ids: TABS.map((t) => t.id),
    activeId: tab,
    onSelect: onTab,
    idOf: (id) => `evx-tab-${id}`,
  });
  if (!ev) return null;
  const status = STATUS_META[ev.status] ?? STATUS_META.draft;
  const staleLive = isStaleLive(ev);
  const tz = eventZone(ev);

  return (
    <div className="space-y-4">
      <section className="admin-workspace-head" data-tour="backstage">
        <EventCover ev={ev} className="admin-workspace-cover" />
        <div className="min-w-0">
          <div className="admin-workspace-titlebar flex flex-wrap items-start justify-between gap-3">
            <div className="admin-workspace-ident min-w-0">
              <p className="eyebrow">Backstage del evento</p>
              <h1 className="admin-workspace-title">{ev.name}</h1>
              <p className="admin-workspace-meta">
                <span>{eventFullDate(ev)}</span>
                <span>{formatEventTime(ev.starts_at, tz)}</span>
                <span>{ev.location || "Lugar por confirmar"}</span>
                <span className="admin-state" data-status={ev.status}>
                  {status.label}
                </span>
                {staleLive && (
                  <span className="admin-warning">Evento pasado · puerta abierta</span>
                )}
              </p>
            </div>
            <div className="admin-workspace-actions">
              <button
                type="button"
                onClick={onExit}
                className="btn-mini"
                data-variant="brand"
              >
                <Icon name="back" className="h-3.5 w-3.5" />
                Volver a Eventos
              </button>
              {editable && (
                <button type="button" onClick={onEdit} className="btn-mini">
                  Editar evento
                </button>
              )}
              {canDelete && ev.status !== "live" && (
                <ActionMenu
                  label={`Opciones de ${ev.name}`}
                  items={[
                    ...(onDuplicate
                      ? [
                          {
                            key: "duplicate",
                            label: "Duplicar evento",
                            icon: "copy",
                            onClick: onDuplicate,
                          },
                        ]
                      : []),
                    {
                      key: "delete",
                      label: "Eliminar evento",
                      icon: "trash",
                      danger: true,
                      onClick: onDelete,
                    },
                  ]}
                />
              )}
            </div>
          </div>

          {ev.description && (
            <p className="admin-workspace-desc mt-2 line-clamp-2 whitespace-pre-line text-pretty text-sm text-zinc-400">
              {ev.description}
            </p>
          )}

          {actions.length > 0 && (
            <div className="admin-workspace-next mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800/80 pt-3">
              <span className="mr-1 text-2xs font-bold uppercase tracking-wide text-zinc-500">
                Siguiente paso
              </span>
              {actions
                .filter((a) => !a.danger)
                .map(({ action, label }) => (
                  <button
                    key={action}
                    onClick={() => onAction(action, label)}
                    disabled={busyAction === action}
                    className="btn-primary !py-1.5 text-xs"
                  >
                    {busyAction === action ? "Procesando…" : label}
                  </button>
                ))}
              {actions.some((a) => a.danger) && (
                <ActionMenu
                  label={`Más acciones de ${ev.name}`}
                  items={actions
                    .filter((a) => a.danger)
                    .map(({ action, label }) => ({
                      key: action,
                      label,
                      icon: "close",
                      danger: true,
                      disabled: busyAction === action,
                      onClick: () => onAction(action, label),
                    }))}
                />
              )}
              {isLive && <LiveIndicator live lastUpdated={lastUpdated} />}
            </div>
          )}
        </div>
      </section>

      <nav
        className="admin-workspace-tabs"
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
            className="admin-workspace-tab"
          >
            {t.label}
          </button>
        ))}
      </nav>
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
