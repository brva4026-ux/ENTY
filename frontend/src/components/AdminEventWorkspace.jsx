import DoorPulse from "./DoorPulse";
import TypeManager from "./TypeManager";
import AllocationManager from "./AllocationManager";
import CouponManager from "./CouponManager";
import TicketList from "./TicketList";
import EventTeamPanel from "./EventTeamPanel";
import PaymentsPanel from "./PaymentsPanel";
import EventSummary, { SectionContext } from "./EventSummary";
import Icon from "./Icon";
import { money, plural } from "../lib/format";
import { isStaleLive } from "../lib/eventTime";

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
  lastUpdated,
}) {
  if (!ev) return null;

  if (section === "resumen") {
    return (
      <EventSummary
        ev={ev}
        report={report}
        types={types}
        allocations={allocations}
        preflight={preflight}
        isLive={isLive}
        lastUpdated={lastUpdated}
        busyAction={busyAction}
        onAction={onAction}
        onSection={onSection}
        onEdit={onEdit}
        editable={editable}
        onCloseNight={onCloseNight}
        venueId={venueId}
        eventId={eventId}
      />
    );
  }

  if (section === "ventas") {
    const paidTickets = report?.by_payment_method
      ?.filter((p) => p.payment_method && p.payment_method !== "cortesia")
      .reduce((n, p) => n + (p.tickets ?? 0), 0);
    const courtesyTickets = (report?.by_type || [])
      .filter((t) => t.is_courtesy)
      .reduce((n, t) => n + (t.issued ?? 0), 0);
    const activeAllocations = (allocations || []).filter(
      (a) => a.is_active !== false,
    );

    return (
      <div className="admin-workspace-panel">
        <SectionContext
          ev={ev}
          next="Vende en la ficha pública, reparte cupos a promotores y audita cada boleta."
        />
        <div className="admin-panel-card">
          <h2>Boletas y precios</h2>
          <p>
            Define localidades, precios, cortesías y el aforo de cada tipo. El
            total no puede superar el aforo del evento.
          </p>
        </div>
        <div className="bs-state-grid bs-state-grid--metrics">
          <div className="bs-metric">
            <span>Recaudo vigente</span>
            <strong className="tnum">{report ? money(report.revenue_cents) : "Sin dato"}</strong>
            <small>Boletas activas e ingresadas.</small>
          </div>
          <div className="bs-metric">
            <span>Boletas pagadas</span>
            <strong className="tnum">{paidTickets ?? "Sin dato"}</strong>
            <small>Venta pública o directa con medio de pago.</small>
          </div>
          <div className="bs-metric">
            <span>Cortesías emitidas</span>
            <strong className="tnum">{report ? courtesyTickets : "Sin dato"}</strong>
            <small>Siempre a $0, con cupo propio.</small>
          </div>
          <div className="bs-metric">
            <span>Anuladas</span>
            <strong className="tnum" data-tone={report?.voided > 0 ? "warn" : undefined}>
              {report ? report.voided : "Sin dato"}
            </strong>
            <small>
              {report ? `${report.refunded ?? 0} reembolsadas` : "Sin dato de reembolsos."}
            </small>
          </div>
        </div>
        <div className="admin-panel-card">
          <h2>Cómo se venden las boletas</h2>
          <ul className="bs-channel-explain">
            <li>
              <strong>Venta pública</strong>
              <span>La ficha del evento vende en línea; el pago se confirma solo.</span>
            </li>
            <li>
              <strong>Emisión por promotores</strong>
              <span>
                {activeAllocations.length
                  ? `${activeAllocations.length} ${plural(activeAllocations.length, "cupo activo", "cupos activos")} en Equipo.`
                  : "Sin cupos activos: asigna cupos en Equipo."}
              </span>
            </li>
            <li>
              <strong>Venta directa</strong>
              <span>El admin emite desde esta pantalla sin consumir cupo de nadie.</span>
            </li>
          </ul>
        </div>
        <TypeManager
          key={eventId}
          venueId={venueId}
          eventId={eventId}
          types={types}
          report={report}
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
    const paidTickets = report?.by_payment_method
      ?.filter((p) => p.payment_method && p.payment_method !== "cortesia")
      .reduce((n, p) => n + (p.tickets ?? 0), 0);
    const incidents =
      report == null
        ? null
        : (report.door_duplicates ?? 0) + (report.door_rejected ?? 0);
    const nextByStatus = {
      live: "Sigue los ingresos y las incidencias; finaliza cuando la noche termine.",
      ended: "Descarga el cierre y revisa las incidencias antes de conciliar.",
      cancelled: "La puerta no opera: revisa las boletas y los pagos en Ventas.",
    };

    return (
      <div className="admin-workspace-panel">
        <SectionContext
          ev={ev}
          next={
            nextByStatus[ev.status] ||
            "Abre puertas cuando el equipo esté listo, prueba un QR y cierra la noche."
          }
        />
        <div className="admin-panel-card">
          <h2>Pulso operativo</h2>
          <p>
            Una lectura de la noche sin inventar ceros: si el servidor no
            reporta un dato, se muestra como ausente.
          </p>
          <div className="bs-state-grid bs-state-grid--metrics mt-3">
            <div className="bs-metric">
              <span>Boletas emitidas</span>
              <strong className="tnum">{report ? report.issued : "Sin dato"}</strong>
              <small>{report ? `${report.capacity} de aforo` : "Esperando reporte"}</small>
            </div>
            <div className="bs-metric">
              <span>Pagos confirmados</span>
              <strong className="tnum">{paidTickets ?? "Sin dato"}</strong>
              <small>
                {paidTickets == null
                  ? "El reporte no trae medios de pago."
                  : `${plural(paidTickets, "boleta pagada", "boletas pagadas")} en el reporte.`}
              </small>
            </div>
            <div className="bs-metric">
              <span>Personas que ingresaron</span>
              <strong className="tnum" data-tone="ok">
                {report ? report.redeemed : "Sin dato"}
              </strong>
              <small>{report ? `${report.pending} sin ingreso` : "Esperando escaneos"}</small>
            </div>
            <div className="bs-metric">
              <span>Pendientes de sincronizar</span>
              <strong className="tnum">Sin dato</strong>
              <small>Se consultan en el escáner de la puerta, no en el servidor.</small>
            </div>
          </div>
        </div>

        <div id="accesos-incidencias" className="admin-panel-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2>Incidencias de puerta</h2>
              <p>
                Duplicados y rechazos que la puerta registró para esta noche.
              </p>
            </div>
            <span className={`bs-status ${incidents > 0 ? "is-warn" : ""}`} data-status={incidents > 0 ? "cancelled" : "published"}>
              <span className="bs-status-dot" aria-hidden="true" />
              {incidents == null ? "Sin dato" : incidents === 0 ? "Sin incidencias" : `${incidents} ${plural(incidents, "incidencia", "incidencias")}`}
            </span>
          </div>
          <div className="bs-incident-grid mt-3">
            <div>
              <span>Duplicados</span>
              <strong className="tnum">{report ? report.door_duplicates ?? 0 : "Sin dato"}</strong>
              <small>QR reescaneado o compartido.</small>
            </div>
            <div>
              <span>Rechazos</span>
              <strong className="tnum">{report ? report.door_rejected ?? 0 : "Sin dato"}</strong>
              <small>Boletas que la puerta no dejó pasar.</small>
            </div>
          </div>
          {report?.by_door?.length > 0 && (
            <ul className="bs-door-list mt-3">
              {report.by_door.map((d) => (
                <li key={d.door_id ?? "sin-puerta"}>
                  <strong>{d.door_id || "Sin puerta identificada"}</strong>
                  <span>{d.granted} ingresos · {d.rejected} rechazos</span>
                </li>
              ))}
            </ul>
          )}
        </div>
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
            {actions.map(({ action, label, danger, secondary }) => (
              <button
                key={action}
                type="button"
                onClick={() => onAction(action)}
                disabled={busyAction === action}
                className={danger ? "btn-mini" : secondary ? "bs-secondary" : "btn-primary"}
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
