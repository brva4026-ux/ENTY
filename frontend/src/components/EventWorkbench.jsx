/* EventWorkbench — el "backstage" de UN evento.
 *
 * Antes: todo el admin era una pestaña plana con un selector de evento suelto;
 * con varios eventos el admin se perdía y la creación no llevaba a ningún lado.
 * Ahora cada evento es su propio espacio de trabajo con URL propia
 * (/admin?event=<id>&tab=<tab>): el enlace es compartible, la recarga no
 * deselecciona y cada tarea vive en su lugar.
 *
 * El selector de eventos queda en la página padre; esto solo es el interior.
 */
import { useState } from "react";
import { useTabKeys } from "../lib/useTabKeys";
import { LiveIndicator } from "./Brand";
import ActionMenu from "./ActionMenu";
import CountUpNumber from "./CountUpNumber";
import EmptyState from "./EmptyState";
import Icon from "./Icon";
import TransitionLink from "./TransitionLink";

/* Etiqueta y color por estado — compartidos con la franja de eventos del
 * admin y el selector del promotor (un solo vocabulario en toda la app). */
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

/** Tips manuscritos del backstage (capa scrapbook): uno por estado, cortos.
 *  Micro-copy que adorna, nunca datos ni acciones. */
const TIPS = {
  draft: "Borrador tranquilo: cuando lo publiques, los promotores ya pueden vender.",
  published: "Ya está a la venta: cada boleta emitida aparece aquí al instante.",
  live: "Puertas abiertas: escanea sin miedo, un QR ya usado muere en el acto.",
  ended: "Noche cerrada: los números quedan aquí para liquidar.",
  cancelled: "Cancelado: las boletas quedaron sin efecto, nadie entra con ellas.",
};

/** Peso operativo: vivos primero, muertos al final (ver AdminDashboard). */
export const STATUS_WEIGHT = {
  live: 0,
  published: 1,
  draft: 2,
  ended: 3,
  cancelled: 4,
};

/** Orden de la franja: lo vivo arriba (lo próximo primero), lo pasado al
 * final (lo más reciente primero). Mismo orden para el aterrizaje por
 * defecto: abrir la app te deja en el evento que importa. */
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

function formatEventDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-CO", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** KPI compacto del header: cifra dominante (cuenta al entrar) + etiqueta. */
function Kpi({ value, label, accent }) {
  return (
    <div className="min-w-16">
      <p
        className={`tnum text-xl font-bold leading-none ${accent ?? "text-ink"}`}
      >
        {typeof value === "number" ? <CountUpNumber value={value} /> : value}
      </p>
      <p className="mt-1 text-2xs font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </p>
    </div>
  );
}

/**
 * @param {object}   ev           Evento seleccionado (objeto completo del API)
 * @param {object}   report       Reporte del evento (issued/redeemed/revenue_cents/…)
 * @param {string}   tab          Pestaña activa
 * @param {function} onTab        Cambio de pestaña (navega con setSearchParams)
 * @param {array}    actions      Acciones de ciclo de vida (NEXT_ACTIONS[status])
 * @param {function} onAction     Ejecutar acción (runAction del padre)
 * @param {string}   busyAction   Acción en vuelo (para deshabilitar su botón)
 * @param {boolean}  isLive       El evento está en puerta (muestra indicador vivo)
 * @param {*}        lastUpdated  Última actualización del refresco en vivo
 * @param {function} onEdit       Abrir edición del evento
 * @param {boolean}  editable     El evento admite edición (draft/published)
 * @param {function} onDelete     Eliminar evento (draft/cancelled)
 * @param {function} onExit       Volver a la lista (sale del modo evento)
 * @param {object}   preflight    Pre-vuelo (roster de puerta + quién canjeó)
 */
export default function EventWorkbench({
  ev,
  report,
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
  onExit,
  preflight,
}) {
  // Hooks SIEMPRE antes de cualquier return condicional (reglas de hooks:
  // un return temprano encima de useState crashea al re-render con ev=null).
  const [badFlyer, setBadFlyer] = useState("");
  if (!ev) return null;
  const status = STATUS_META[ev.status] ?? STATUS_META.draft;
  // URL de flyer que ya falló al cargar: el padre reinicia esto al editar.
  const showFlyer = ev.flyer_url && ev.flyer_url !== badFlyer;

  // KPIs del header: el pulso del evento sin entrar a ninguna pestaña.
  const issued = report?.issued ?? null;
  const redeemed = report?.redeemed ?? null;
  const revenue = report?.revenue_cents ?? null;
  // Solo pestañas DE ESTE evento. Equipo/Liquidaciones/Invitaciones son de la
  // venue (no cambian con el evento elegido): viven en la lista, no dentro del
  // backstage — mezclarlas aquí es lo que hacia sentir "todo amontonado".
  // La ÚNICA excepción es "equipo de la noche": el roster y los links de puerta
  // sí son por evento (mig 025), así que viven acá donde se trabaja la noche.
  const tabs = [
    { id: "resumen", label: "Resumen", icon: "chart" },
    { id: "entradas", label: "Entradas", icon: "door" },
    { id: "cupos", label: "Cupos", icon: "users" },
    { id: "boletas", label: "Boletas", icon: "ticket" },
    { id: "lineup", label: "Lineup", icon: "sparkle" },
    { id: "cupones", label: "Cupones", icon: "money" },
    { id: "noche", label: "Equipo", icon: "users" },
  ];
  const wbTabs = useTabKeys({
    ids: tabs.map((t) => t.id),
    activeId: tab,
    onSelect: onTab,
    idOf: (id) => `evx-tab-${id}`,
  });

  return (
    <div className="space-y-4">
      {/* ====== Cabecera del evento: la MISMA gramática de la portada ======
        eyebrow + display + punto de estado (no degradado ni píldora con
        ring): entrar al backstage debe sentirse BAJAR un nivel de la misma
        jerarquía, no cambiar de aplicación. */}
      <section className="card card-hero p-5" data-tour="backstage">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {showFlyer && (
            <img
              src={ev.flyer_url}
              alt=""
              onError={() => setBadFlyer(ev.flyer_url)}
              className="wb-flyer h-16 w-16 shrink-0 sm:h-20 sm:w-20"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Backstage del evento</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2.5">
              <h1 className="display truncate text-lg sm:text-xl">
                {ev.name}
              </h1>
              <span className="evx-state">
                <span
                  className="evx-dot"
                  data-status={ev.status}
                  aria-hidden="true"
                />
                {status.label}
              </span>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
              {formatEventDate(ev.starts_at)}
              {ev.ends_at ? ` → ${formatEventDate(ev.ends_at)}` : ""}
              <span className="text-zinc-600">·</span>
              <span className="tnum">aforo {ev.capacity}</span>
              {ev.location && (
                <>
                  <span className="text-zinc-600">·</span>
                  <span className="truncate">{ev.location}</span>
                </>
              )}
            </p>
            {ev.description && (
              <p className="mt-2 line-clamp-2 whitespace-pre-line text-pretty text-sm text-zinc-400">
                {ev.description}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onExit}
              data-tip="Volver a la lista de eventos"
              className="btn-ghost !px-3 !py-1.5 text-xs font-bold"
            >
              {/* "back" (flecha de regreso), NO "logout": este botón solo
                navega; el icono de salida sugería cerrar sesión. */}
              <Icon name="back" className="h-3.5 w-3.5" />
              Volver
            </button>
            {editable && (
              <button
                onClick={onEdit}
                className="btn-ghost !px-3 !py-1.5 text-xs font-bold"
              >
                Editar
              </button>
            )}
            {/* Eliminar sale de la banda de acciones y va al menú "…": es
              destructivo e irreversible y competía al mismo nivel que
              "Volver"/"Editar". Ley de Hick: una decisión peligrosa a un
              toque de distancia, no en la primera fila. */}
            {ev.status !== "live" && (
              <ActionMenu
                label={`Opciones de ${ev.name}`}
                items={[
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

        {/* Pulso del evento con la jerarquía de la portada: el RECAUDO manda
          (grande, verde), las tres operativas en tinta media. Antes los 4
          KPIs del mismo peso hacían que nada destacara. */}
        <div className="wb-pulse mt-4">
          <div className="wb-kpi-main">
            <p className="wb-kpi-label">Recaudo</p>
            <p className="wb-revenue tnum">
              {revenue !== null ? (
                <CountUpNumber
                  value={revenue / 100}
                  format={(v) =>
                    `$${Math.round(v).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`
                  }
                />
              ) : (
                "—"
              )}
            </p>
          </div>
          <div className="wb-kpis">
            <Kpi value={issued ?? "—"} label="Emitidas" />
            <Kpi value={redeemed ?? "—"} label="Ingresaron" />
            <Kpi value={ev.capacity} label="Aforo" />
            <LiveIndicator live={isLive} lastUpdated={lastUpdated} />
          </div>
        </div>

        {/* Salud de puerta: solo aparece cuando hay algo que mirar. Un pico de
          duplicados es el síntoma de un QR reenviado/clonado y el admin debe
          verlo en vivo, no al día siguiente en el CSV. Un "0" permanente solo
          sería ruido. */}
        {(report?.door_duplicates > 0 || report?.door_rejected > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-zinc-940 px-3 py-2 text-xs">
            {report.door_duplicates > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
                <span className="tnum font-semibold text-amber-400">
                  {report.door_duplicates}
                </span>
                <span className="text-amber-300/80">
                  {report.door_duplicates === 1
                    ? "boleta reescaneada"
                    : "boletas reescaneadas"}
                </span>
              </span>
            )}
            {report.door_rejected > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" aria-hidden="true" />
                <span className="tnum font-semibold text-zinc-300">
                  {report.door_rejected}
                </span>
                <span className="text-zinc-500">
                  {report.door_rejected === 1 ? "rechazada" : "rechazadas"}
                </span>
              </span>
            )}
          </div>
        )}

        {/* Píldora de turno (tanda 3): quién está en puerta ESTA noche y si
          su escáner ya está activo. Antes `shift_start/shift_end` se guardaban
          y nadie los veía; el admin abría puertas a ciegas. */}
        {preflight && preflight.bouncers > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-zinc-940 px-3 py-2 text-xs">
            <Icon name="users" className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span className="text-zinc-400">Puerta:</span>
            {preflight.door_staff.map((s) => (
              <span
                key={s.user_id}
                className="inline-flex items-center gap-1"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    s.link_used ? "bg-emerald-400" : "bg-amber-400"
                  }`}
                  aria-hidden="true"
                />
                <span className="font-medium text-zinc-200">
                  {s.full_name}
                </span>
                {(s.shift_start || s.shift_end) && (
                  <span className="tnum text-zinc-500">
                    ({s.shift_start ? new Date(s.shift_start).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : ""}
                    {s.shift_end ? `–${new Date(s.shift_end).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}` : ""})
                  </span>
                )}
              </span>
            ))}
            {!preflight.door_ready && (
              <span className="text-amber-400">· nadie abrió su link aún</span>
            )}
          </div>
 )}

        {/* Ciclo de vida: el paso principal SIEMPRE visible y destacado; las
          acciones destructivas (Cancelar) van al menú "…". Antes Publicar y
          Cancelar pesaban casi igual y la decisión "¿qué hago ahora?" se
          diluía. Ley de Hick: una acción primaria por banda. */}
        {actions.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-800/80 pt-4">
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
                  {busyAction === action && (
                    <svg
                      className="btn-spinner"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                  )}
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
          </div>
        )}

        {/* Nota de scrapbook: tip manuscrito segun el ciclo de vida, como las
          notas pegadas del cartel. Unica por estado, cero datos duros. */}
        {TIPS[ev.status] && (
          <p className="paper-note mt-4 inline-block rotate-[-0.6deg]">
            {TIPS[ev.status]}
          </p>
        )}
      </section>

      {/* ====== Pestañas internas: mismos evx-tab de la portada. La tabbar
        hundida con gradientes era EL elemento que más rompía la continuidad. */}
      <nav
        className="no-scrollbar -mx-4 flex max-w-full items-center gap-1 overflow-x-auto px-4"
        role="tablist"
        aria-label="Secciones del evento"
        data-tour="tabs-evento"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`evx-tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="evx-tab-panel"
            tabIndex={wbTabs.tabIndexFor(t.id)}
            onKeyDown={wbTabs.onKeyDown}
            onClick={() => onTab(t.id)}
            className={`evx-tab ${tab === t.id ? "is-active" : ""}`}
          >
            <Icon name={t.icon} className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

/** Pantalla de evento inexistente o borrado (enlace viejo, evento eliminado). */
export function EventNotFound({ onBack }) {
  return (
    <EmptyState icon="alert" title="Este evento no existe">
      Puede que el enlace sea viejo o que el evento se haya eliminado.
      <span className="mt-3 block">
        <TransitionLink
          to="/admin"
          onClick={() => onBack?.()}
          className="btn-primary inline-block px-4 py-2 text-xs font-bold"
        >
          Ver mis eventos
        </TransitionLink>
      </span>
    </EmptyState>
  );
}
