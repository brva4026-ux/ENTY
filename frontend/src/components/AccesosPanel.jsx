import DoorPulse from "./DoorPulse";
import ZonesPanel from "./ZonesPanel";
import DoorIncidentsPanel from "./DoorIncidentsPanel";
import Icon from "./Icon";
import { LiveIndicator } from "./Brand";
import { SectionContext } from "./EventSummary";
import { money, plural } from "../lib/format";
import { isStaleLive } from "../lib/eventTime";

const SYNC_NOTE =
  "El servidor no expone la cola offline; si el escáner tiene ingresos sin sincronizar, el cierre puede variar.";

export default function AccesosPanel({
  ev,
  report,
  preflight,
  isLive,
  actions,
  busyAction,
  onAction,
  onQrTest,
  closing,
  onCloseNight,
  onCloseCaja,
  cajaRange,
  setCajaRange,
  cajaBusy,
  lastUpdated,
  venueId,
  types,
  onTypesChanged,
}) {
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
  const scrollToIncidents = () =>
    document
      .getElementById("accesos-incidencias")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  const consolidation = report
    ? "Reporte del servidor recibido"
    : "Sin reporte todavía";

  const metrics = (
    <>
      <div className="bs-metric">
        <span>Dinero cobrado</span>
        <strong className="tnum">{report ? money(report.revenue_cents) : "Sin dato"}</strong>
        <small>Pagos aprobados; no incluye cortesías.</small>
      </div>
      <div className="bs-metric">
        <span>Boletas emitidas</span>
        <strong className="tnum">{report ? report.issued : "Sin dato"}</strong>
        <small>{report ? `${report.capacity} de aforo` : "Esperando reporte"}</small>
      </div>
      <div className="bs-metric">
        <span>Personas que ingresaron</span>
        <strong className="tnum" data-tone="ok">
          {report ? report.redeemed : "Sin dato"}
        </strong>
        <small>{report ? `${report.pending} sin ingreso` : "Esperando escaneos"}</small>
      </div>
      <div className="bs-metric">
        <span>Incidencias</span>
        <strong className="tnum" data-tone={incidents > 0 ? "warn" : undefined}>
          {incidents == null ? "Sin dato" : incidents}
        </strong>
        <small>Duplicados y rechazos de la puerta.</small>
      </div>
    </>
  );

  return (
    <div className="admin-workspace-panel">
      <SectionContext
        ev={ev}
        next={
          nextByStatus[ev.status] ||
          "Configura zonas, abre puertas cuando el equipo esté listo y cierra la noche."
        }
      />

      <ZonesPanel
        venueId={venueId}
        eventId={ev.id}
        types={types}
        onTypesChanged={onTypesChanged}
        live={isLive}
      />

      {ev.status === "live" && (
        <div className="admin-panel-card bs-live-hero">
          <div className="bs-live-hero-head">
            <div>
              <h2 className="bs-live-hero-title">
                Puerta en vivo <LiveIndicator live lastUpdated={lastUpdated} />
              </h2>
              <p>
                {report
                  ? `${report.redeemed} de ${report.issued} ${report.issued === 1 ? "boleta" : "boletas"} con ingreso.`
                  : "Esperando el primer reporte de la puerta."}
              </p>
            </div>
            <div className="bs-live-hero-actions">
              <button type="button" className="btn-primary" onClick={scrollToIncidents}>
                <Icon name="alert" className="h-4 w-4" />
                Ver incidencias
              </button>
              <button
                type="button"
                className="bs-secondary"
                onClick={() => onAction("end")}
                disabled={busyAction === "end"}
              >
                {busyAction === "end" ? "Finalizando…" : "Finalizar evento"}
              </button>
            </div>
          </div>
          <div className="bs-state-grid bs-state-grid--metrics">{metrics}</div>
        </div>
      )}

      {ev.status === "ended" && (
        <div className="admin-panel-card bs-live-hero bs-live-hero--ended">
          <div className="bs-live-hero-head">
            <div>
              <h2 className="bs-live-hero-title">Cierre de la noche</h2>
              <p>
                Informe del servidor con boletas, ingresos e incidencias para
                conciliar caja y puerta.
              </p>
            </div>
            <div className="bs-live-hero-actions">
              <button type="button" className="btn-primary" onClick={onCloseNight}>
                <Icon name="download" className="h-4 w-4" />
                Descargar cierre
              </button>
              <button
                type="button"
                className="bs-secondary"
                onClick={onCloseCaja}
                disabled={cajaBusy}
              >
                {cajaBusy ? "Preparando…" : "Caja (CSV)"}
              </button>
            </div>
          </div>
          <div className="bs-state-grid bs-state-grid--metrics">{metrics}</div>
          <p className="admin-note">
            Estado de consolidación: {consolidation}. {SYNC_NOTE}
          </p>
        </div>
      )}

      {ev.status !== "live" && ev.status !== "ended" && (
        <div className="admin-panel-card">
          <h2>Pulso operativo</h2>
          <p>
            Una lectura de la noche sin inventar ceros: si el servidor no
            reporta un dato, se muestra como ausente.
          </p>
          <div className="bs-state-grid bs-state-grid--metrics bs-state-grid--five mt-3">
            <div className="bs-metric">
              <span>Dinero cobrado</span>
              <strong className="tnum">
                {report ? money(report.revenue_cents) : "Sin dato"}
              </strong>
              <small>Pagos aprobados; no incluye cortesías.</small>
            </div>
            <div className="bs-metric">
              <span>Boletas emitidas</span>
              <strong className="tnum">{report ? report.issued : "Sin dato"}</strong>
              <small>{report ? `${report.capacity} de aforo` : "Esperando reporte"}</small>
            </div>
            <div className="bs-metric">
              <span>Boletas pagadas</span>
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
              <strong className="tnum">No disponible</strong>
              <small>{SYNC_NOTE}</small>
            </div>
          </div>
        </div>
      )}

      <div id="accesos-incidencias" className="admin-panel-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2>Incidencias de puerta</h2>
            <p>Duplicados y rechazos que la puerta registró para esta noche.</p>
          </div>
          <span
            className={`bs-status ${incidents > 0 ? "is-warn" : ""}`}
            data-status={incidents > 0 ? "cancelled" : "live"}
          >
            <span className="bs-status-dot" aria-hidden="true" />
            {incidents == null
              ? "Sin dato"
              : incidents === 0
                ? "Sin incidencias"
                : `${incidents} ${plural(incidents, "incidencia", "incidencias")}`}
          </span>
        </div>
        <div className="bs-incident-grid mt-3">
          <div>
            <span>Duplicados</span>
            <strong className="tnum">
              {report ? report.door_duplicates ?? 0 : "Sin dato"}
            </strong>
            <small>QR reescaneado o compartido.</small>
          </div>
          <div>
            <span>Rechazos</span>
            <strong className="tnum">
              {report ? report.door_rejected ?? 0 : "Sin dato"}
            </strong>
            <small>Boletas que la puerta no dejó pasar.</small>
          </div>
        </div>
        {report?.by_door?.length > 0 && (
          <ul className="bs-door-list mt-3">
            {report.by_door.map((d) => (
              <li key={d.door_id ?? "sin-puerta"}>
                <strong>{d.door_id || "Sin puerta identificada"}</strong>
                <span>
                  {d.granted} ingresos · {d.rejected} rechazos
                </span>
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
              {ev.status === "live"
                ? "La puerta está abierta. Finaliza desde el resumen de arriba cuando termine la noche."
                : "Abre puertas cuando el equipo esté listo. Finalizar corta los escaneos; reabrir los restaura dentro de la gracia."}
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
          {ev.status !== "live" &&
            actions.map(({ action, label, danger, secondary }) => (
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
          {ev.status === "live" && (
            <span className="admin-note">
              Usa «Finalizar evento» en el resumen de la puerta en vivo.
            </span>
          )}
          {ev.status !== "live" && actions.length === 0 && (
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
              {s.device_active
                ? ` · ${s.door_name || "Puerta"} · ${s.device_phone || "teléfono autorizado"}`
                : s.has_link
                  ? " · link emitido"
                  : " · sin link"}
            </li>
          ))}
        </ul>
      </div>

      {venueId && (
        <DoorIncidentsPanel venueId={venueId} eventId={ev.id} role="admin" />
      )}

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
              ["Dinero cobrado", money(report?.revenue_cents ?? 0)],
              ["Boletas emitidas", report?.issued ?? 0],
              ["Personas que ingresaron", report?.redeemed ?? 0],
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
