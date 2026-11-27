import { useState } from "react";
import TypeManager from "./TypeManager";
import AllocationManager from "./AllocationManager";
import CouponManager from "./CouponManager";
import TicketList from "./TicketList";
import EventTeamPanel from "./EventTeamPanel";
import AccesosPanel from "./AccesosPanel";
import PaymentsPanel from "./PaymentsPanel";
import BoxOfficePanel from "./BoxOfficePanel";
import AccreditationsPanel from "./AccreditationsPanel";
import SessionsPanel from "./SessionsPanel";
import BreakEvenPanel from "./BreakEvenPanel";
import EventExtrasPanel from "./EventExtrasPanel";
import EventMorePanel, { RsvpSection } from "./EventMorePanel";
import EventSummary from "./EventSummary";
import { money } from "../lib/format";

function WorkspacePicker({ label, options, value, onChange }) {
  return (
    <div className="bs-subnav workspace-picker" role="group" aria-label={label}>
      {options.map(([id, title]) => (
        <button key={id} type="button" className="bs-subnav-tab"
          aria-pressed={value === id} onClick={() => onChange(id)}>
          {title}
        </button>
      ))}
    </div>
  );
}

function OperationsWorkspace(props) {
  const [view, setView] = useState("production");
  return (
    <>
      <WorkspacePicker label="Herramientas de operación" value={view} onChange={setView}
        options={[["production", "Producción"], ["tools", "Herramientas complementarias"]]} />
      {view === "production" ? <EventExtrasPanel {...props} /> : <EventMorePanel {...props} />}
    </>
  );
}

const SALES_VIEWS = [
  ["tipos", "Tipos de boleta"],
  ["boletas", "Emitidas"],
  ["invitados", "Invitados"],
  ["cobros", "Cobros"],
  ["taquilla", "Taquilla"],
  ["cupones", "Cupones"],
];

function SalesWorkspace({ ev, report, types, venueId, eventId, onChanged, onTypesChanged, onError }) {
  const [view, setView] = useState("tipos");
  const paidTickets = report?.by_payment_method
    ?.filter((p) => p.payment_method && p.payment_method !== "cortesia")
    .reduce((n, p) => n + (p.tickets ?? 0), 0);
  const courtesyTickets = (report?.by_type || [])
    .filter((t) => t.is_courtesy)
    .reduce((n, t) => n + (t.issued ?? 0), 0);
  return (
    <div className="admin-workspace-panel">
      {report && ev.status !== "draft" && (
        <div className="bs-state-grid bs-state-grid--metrics">
          <div className="bs-metric">
            <span>Recaudo</span>
            <strong className="tnum">{money(report.revenue_cents)}</strong>
          </div>
          <div className="bs-metric">
            <span>Emitidas</span>
            <strong className="tnum">{report.issued}</strong>
          </div>
          <div className="bs-metric">
            <span>Pagadas</span>
            <strong className="tnum">{paidTickets ?? "Sin dato"}</strong>
          </div>
          <div className="bs-metric">
            <span>Cortesías emitidas</span>
            <strong className="tnum">{courtesyTickets}</strong>
          </div>
        </div>
      )}
      <WorkspacePicker label="Gestionar ventas" options={SALES_VIEWS} value={view} onChange={setView} />
      {view === "tipos" && (
        <TypeManager
          key={eventId}
          venueId={venueId}
          eventId={eventId}
          types={types}
          report={report}
          onChange={(next) => {
            onTypesChanged?.(next);
            onChanged?.();
          }}
          capacity={ev.capacity}
        />
      )}
      {view === "cupones" && <CouponManager venueId={venueId} eventId={eventId} types={types} />}
      {view === "boletas" && (
        <div className="bs-sales-list">
          <TicketList
            venueId={venueId}
            eventId={eventId}
            types={types}
            onChanged={onChanged}
            onError={onError}
            title="Boletas emitidas"
          />
        </div>
      )}
      {view === "invitados" && (
        <div className="bs-sales-list">
          <details className="admin-task-details bs-guest-import">
            <summary>Importar invitados</summary>
            <RsvpSection key={eventId} venueId={venueId} eventId={eventId} eventName={ev.name} />
          </details>
          <TicketList
            venueId={venueId}
            eventId={eventId}
            types={types}
            onChanged={onChanged}
            onError={onError}
            courtesyOnly
            showTypeFilter={false}
            title="Invitados y cortesías"
            emptyTitle="Aún no hay invitados con cortesía"
            emptyBody="Cuando emitas una cortesía, aparecerá aquí para la puerta."
          />
        </div>
      )}
      {view === "cobros" && (
        <PaymentsPanel
          venueId={venueId}
          events={[ev]}
          initialEventId={ev.id}
          report={report}
        />
      )}
      {view === "taquilla" && (
        <BoxOfficePanel
          ev={ev}
          report={report}
          types={types}
          venueId={venueId}
          eventId={eventId}
          onChanged={onChanged}
        />
      )}
    </div>
  );
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
  onPreview,
  editable,
  venueId,
  eventId,
  onChanged,
  onTypesChanged,
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
        onPreview={onPreview}
        editable={editable}
        onCloseNight={onCloseNight}
        venueId={venueId}
        eventId={eventId}
      />
    );
  }

  if (section === "rentabilidad") {
    return (
      <div className="admin-workspace-panel">
        <BreakEvenPanel venueId={venueId} eventId={eventId} ev={ev} />
      </div>
    );
  }

  if (section === "ventas") {
    return (
      <SalesWorkspace key={eventId} ev={ev} report={report} types={types}
        venueId={venueId} eventId={eventId} onChanged={onChanged}
        onTypesChanged={onTypesChanged} onError={onError} />
    );
  }

  if (section === "equipo") {
    return (
      <div className="admin-workspace-panel">
        <EventTeamPanel venueId={venueId} event={ev} preflight={preflight} />
        <details className="admin-task-details">
          <summary>Cupos de promotores</summary>
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
        </details>
      </div>
    );
  }

  if (section === "sesiones") {
    return (
      <div className="admin-workspace-panel">
        <SessionsPanel venueId={venueId} eventId={eventId} ev={ev} />
      </div>
    );
  }
  if (section === "acreditaciones") {
    return (
      <div className="admin-workspace-panel">
        <AccreditationsPanel venueId={venueId} eventId={eventId} ev={ev} />
      </div>
    );
  }

  if (section === "operacion") {
    return (
      <div className="admin-workspace-panel">
        <OperationsWorkspace key={eventId} venueId={venueId} eventId={eventId} types={types} />
      </div>
    );
  }

  if (section === "accesos") {
    return (
      <AccesosPanel
        ev={ev}
        report={report}
        preflight={preflight}
        isLive={isLive}
        actions={actions}
        busyAction={busyAction}
        onAction={onAction}
        onQrTest={onQrTest}
        closing={closing}
        onCloseNight={onCloseNight}
        onCloseCaja={onCloseCaja}
        cajaRange={cajaRange}
        setCajaRange={setCajaRange}
        cajaBusy={cajaBusy}
        lastUpdated={lastUpdated}
        venueId={venueId}
        types={types}
        onTypesChanged={onTypesChanged}
      />
    );
  }

  return null;
}
