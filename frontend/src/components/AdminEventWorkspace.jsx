import ReportWidget from "./ReportWidget";
import DoorPulse from "./DoorPulse";
import { StatSkeletonRow } from "./Skeleton";
import TypeManager from "./TypeManager";
import LineupManager from "./LineupManager";
import AllocationManager from "./AllocationManager";
import CouponManager from "./CouponManager";
import TicketList from "./TicketList";
import EventTeamPanel from "./EventTeamPanel";
import PaymentsPanel from "./PaymentsPanel";
import EventCover, { eventFullDate } from "./EventCover";
import Icon from "./Icon";
import { money } from "../lib/format";
import { isStaleLive } from "../lib/eventTime";

function SectionContext({ ev, next }) {
  return (
    <div className="bs-section-context">
      <p>
        <strong>{ev.name}</strong>
        <span aria-hidden="true">·</span>
        {eventFullDate(ev)}
        <span aria-hidden="true">·</span>
        {ev.location || "Lugar por confirmar"}
      </p>
      <p className="bs-section-next">{next}</p>
    </div>
  );
}

function StatusLine({ ev }) {
  if (ev.status === "draft") return "Borrador (no visible al público)";
  if (ev.status === "published") return "A la venta";
  if (ev.status === "live") return "En puerta";
  if (ev.status === "ended") return "Finalizado";
  return "Cancelado";
}

export default function AdminEventWorkspace({
  ev,
  section,
  report,
  types,
  allocations,
  users,
  preflight,
  isLive,
  actions,
  busyAction,
  onAction,
  onSection,
  onEdit,
  editable,
  venueId,
  eventId,
  onChanged,
  onError,
  onQrTest,
  closing,
  onCloseNight,
  onCloseCaja,
  cajaRange,
  setCajaRange,
  cajaBusy,
}) {
  if (!ev) return null;

  if (section === "resumen") {
    const checks = [
      [types.filter((t) => t.is_active !== false).length > 0, "Tipo de boleta activo"],
      [(preflight?.bouncers ?? 0) > 0, "Personal de puerta asignado"],
      [preflight?.door_ready === true, "Escáner activo (link de puerta abierto)"],
      [allocations.length > 0, "Cupos de promotores definidos"],
      [Boolean(ev.location), "Lugar confirmado"],
      [Boolean(ev.description), "Descripción pública escrita"],
    ];
    return (
      <div className="admin-workspace-panel">
        <SectionContext
          ev={ev}
          next="Revisa la ficha, completa los pendientes y compártela cuando esté lista."
        />
        <div className="admin-panel-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2>Ficha pública</h2>
              <p>Así ve el comprador esta noche antes de pagar.</p>
            </div>
            <a
              className="admin-inline-link"
              href={`/evento/${ev.id}?preview=1`}
              target="_blank"
              rel="noreferrer"
            >
              Abrir vista previa
            </a>
          </div>
          <div className="admin-preview-card mt-3">
            <EventCover ev={ev} showTime={false} />
            <div className="min-w-0">
              <b>{ev.name}</b>
              <span>{eventFullDate(ev)}</span>
              <span>
                {ev.location || "Lugar por confirmar"} ·{" "}
                {ev.category || "Sin categoría"}
              </span>
              <span>
                Aforo {ev.capacity} · <StatusLine ev={ev} />
              </span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-mini"
              data-variant="brand"
              onClick={() => onSection("ventas")}
            >
              Ver ventas
            </button>
            <button
              type="button"
              className="btn-mini"
              onClick={() => onSection("equipo")}
            >
              Ver equipo
            </button>
            <button
              type="button"
              className="btn-mini"
              onClick={() => onSection("accesos")}
            >
              Ver puerta
            </button>
            {editable && (
              <button type="button" className="btn-mini" onClick={onEdit}>
                Editar evento
              </button>
            )}
          </div>
        </div>

        <LineupManager venueId={venueId} eventId={eventId} />

        <div className="admin-panel-card">
          <h2>Pendientes comprobables</h2>
          <p>Lo que falta para que la noche esté realmente lista.</p>
          <ul className="admin-check-list">
            {checks.map(([ok, label]) => (
              <li key={label} className={ok ? "is-ok" : "is-warn"}>
                <span className="admin-check-icon" aria-hidden="true">
                  {ok ? "✓" : "!"}
                </span>
                {label}
              </li>
            ))}
          </ul>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          {report ? <ReportWidget report={report} /> : <StatSkeletonRow />}
          <div className="admin-panel-card">
            <p className="eyebrow">Pulso de la noche</p>
            <h2 className="mt-0.5">Cómo va la puerta</h2>
            <div className="mt-3 space-y-2 text-sm text-zinc-300">
              <div className="flex items-center justify-between gap-2">
                <span>Boletas emitidas</span>
                <span className="tnum font-bold">{report?.issued ?? "…"}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span>Ya ingresaron</span>
                <span className="tnum font-bold text-emerald-300">
                  {report?.redeemed ?? "…"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span>Pendientes de entrar</span>
                <span className="tnum font-bold text-amber-300">
                  {report
                    ? Math.max(0, (report.issued ?? 0) - (report.redeemed ?? 0))
                    : "…"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span>Aforo disponible</span>
                <span className="tnum font-bold">
                  {report
                    ? Math.max(0, (ev.capacity ?? 0) - (report.issued ?? 0))
                    : "…"}
                </span>
              </div>
            </div>
            {isLive && (
              <p className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 ring-1 ring-emerald-500/30">
                <span className="dp-live-dot shrink-0" aria-hidden="true" />
                Puertas abiertas: los escaneos actualizan estas cifras en vivo.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (section === "ventas") {
    return (
      <div className="admin-workspace-panel">
        <SectionContext
          ev={ev}
          next="Define localidades, cupones y audita cada boleta emitida."
        />
        <div className="admin-panel-card">
          <h2>Boletas y precios</h2>
          <p>
            Define localidades, precios, cortesías y el aforo de cada tipo. El
            total no puede superar el aforo del evento.
          </p>
        </div>
        <TypeManager
          key={eventId}
          venueId={venueId}
          eventId={eventId}
          types={types}
          onChange={onChanged}
          capacity={ev.capacity}
        />
        <CouponManager
          key={`coupons-${eventId}`}
          venueId={venueId}
          eventId={eventId}
          types={types}
        />
        <div className="admin-panel-card">
          <h2>Boletas vendidas</h2>
          <p>
            Audita lo emitido, reenvía el QR y revisa el estado de cada boleta.
          </p>
          <div className="mt-4">
            <TicketList
              venueId={venueId}
              eventId={eventId}
              types={types}
              onChanged={onChanged}
              onError={onError}
            />
          </div>
        </div>
        <div className="admin-panel-card">
          <h2>Cobros online</h2>
          <p>Enlaces de pago de Wompi, cobros pendientes y boletas emitidas.</p>
          <div className="mt-4">
            <PaymentsPanel venueId={venueId} events={[ev]} initialEventId={ev.id} />
          </div>
        </div>
      </div>
    );
  }

  if (section === "equipo") {
    return (
      <div className="admin-workspace-panel">
        <SectionContext
          ev={ev}
          next="Asigna puerta y venta, emite enlaces y reparte cupos entre promotores."
        />
        <div className="admin-panel-card">
          <h2>Personal de esta noche</h2>
          <p>
            Asigna quién escanea y quién vende. Los permisos generales se
            administran en Organización; aquí se resuelve la noche.
          </p>
        </div>
        <EventTeamPanel venueId={venueId} event={ev} preflight={preflight} />
        <div className="admin-panel-card">
          <h2>Cupos de promotores</h2>
          <p>
            Reparte cupos por tipo de boleta. Las ventas directas del admin no
            consumen cupo de nadie.
          </p>
          <div className="mt-4">
            <AllocationManager
              venueId={venueId}
              eventId={eventId}
              allocations={allocations}
              types={types}
              users={users}
              onChange={onChanged}
            />
          </div>
        </div>
      </div>
    );
  }

  if (section === "accesos") {
    return (
      <div className="admin-workspace-panel">
        <SectionContext
          ev={ev}
          next="Abre puertas cuando el equipo esté listo, prueba un QR y cierra la noche."
        />
        <div className="admin-panel-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow">Control de puerta</p>
              <h2 className="mt-0.5">Apertura y cierre</h2>
              <p>
                Abre puertas cuando el equipo esté listo. Finalizar corta los
                escaneos; reabrir los restaura dentro de la gracia.
              </p>
            </div>
            <button
              type="button"
              className="btn-mini"
              data-variant="brand"
              onClick={onQrTest}
            >
              <Icon name="qr" className="h-3.5 w-3.5" />
              Probar un QR
            </button>
          </div>
          {isStaleLive(ev) && (
            <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-500/30">
              Este evento ya pasó pero la puerta sigue abierta. Finaliza para
              cerrar la noche.
            </p>
          )}
          <div className="admin-workspace-actions">
            {actions.map(({ action, label, danger }) => (
              <button
                key={action}
                type="button"
                onClick={() => onAction(action)}
                disabled={busyAction === action}
                className={danger ? "btn-mini" : "btn-primary"}
                data-variant={danger ? "danger" : undefined}
              >
                {busyAction === action ? "Procesando…" : label}
              </button>
            ))}
            {actions.length === 0 && (
              <span className="admin-note">
                No hay transiciones disponibles para este estado.
              </span>
            )}
          </div>
        </div>

        <div className="admin-panel-card">
          <h2>Preflight de puerta</h2>
          <p>Quién está asignado y si su escáner ya está activo.</p>
          <ul className="admin-check-list">
            <li className={(preflight?.bouncers ?? 0) > 0 ? "is-ok" : "is-warn"}>
              <span className="admin-check-icon" aria-hidden="true">
                {(preflight?.bouncers ?? 0) > 0 ? "✓" : "!"}
              </span>
              {(preflight?.bouncers ?? 0) > 0
                ? `${preflight.bouncers} persona(s) en puerta`
                : "Nadie asignado a puerta"}
            </li>
            <li className={preflight?.door_ready ? "is-ok" : "is-warn"}>
              <span className="admin-check-icon" aria-hidden="true">
                {preflight?.door_ready ? "✓" : "!"}
              </span>
              {preflight?.door_ready
                ? "Escáner activo"
                : "Nadie ha abierto el link de puerta"}
            </li>
            {(preflight?.door_staff ?? []).map((s) => (
              <li key={s.user_id ?? s.full_name} className="is-ok">
                <span className="admin-check-icon" aria-hidden="true">
                  ✓
                </span>
                {s.full_name}
                {s.has_link ? " · link emitido" : " · sin link"}
              </li>
            ))}
          </ul>
        </div>

        {report && <DoorPulse pulse={report.door_pulse} isLive={isLive} />}

        {closing && (
          <div className="admin-panel-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="eyebrow">Cierre de noche</p>
                <p className="mt-0.5 text-sm text-zinc-400">
                  Caja + puerta + equipo en un CSV para el contador. El cierre
                  trae toda la noche; la caja se puede acotar a un rango de
                  fechas.
                </p>
              </div>
              <button onClick={onCloseNight} className="btn-primary shrink-0">
                <Icon name="download" className="h-4 w-4" />
                Cerrar noche
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-zinc-800 pt-3">
              <label className="flex flex-col gap-1 text-2xs uppercase tracking-wide text-zinc-500">
                Desde
                <input
                  type="date"
                  value={cajaRange.desde}
                  onChange={(e) =>
                    setCajaRange({ ...cajaRange, desde: e.target.value })
                  }
                  className="field"
                  aria-label="Caja desde"
                />
              </label>
              <label className="flex flex-col gap-1 text-2xs uppercase tracking-wide text-zinc-500">
                Hasta
                <input
                  type="date"
                  value={cajaRange.hasta}
                  onChange={(e) =>
                    setCajaRange({ ...cajaRange, hasta: e.target.value })
                  }
                  className="field"
                  aria-label="Caja hasta"
                />
              </label>
              <button
                onClick={onCloseCaja}
                disabled={cajaBusy}
                className="btn-ghost shrink-0"
              >
                <Icon name="download" className="h-4 w-4" />
                {cajaBusy ? "Preparando…" : "Caja (CSV)"}
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Recaudo", money(report?.revenue_cents ?? 0)],
                ["Vendidas", report?.issued ?? 0],
                ["Entraron", report?.redeemed ?? 0],
                ["En puerta", preflight?.bouncers ?? 0],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-zinc-940 px-3 py-2">
                  <p className="text-2xs uppercase tracking-wide text-zinc-500">
                    {label}
                  </p>
                  <p className="tnum mt-0.5 text-lg font-bold text-zinc-100">
                    {value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return null;
}
