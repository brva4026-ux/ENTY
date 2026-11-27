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

const SALES_VIEWS = [
  {
    id: "boletas",
    label: "Boletas",
  },
  {
    id: "invitados",
    label: "Invitados",
  },
  {
    id: "cobros",
    label: "Cobros",
  },
  {
    id: "taquilla",
    label: "Taquilla",
  },
];

function SalesLedger({
  ev,
  report,
  types,
  venueId,
  eventId,
  onChanged,
  onError,
}) {
  const [view, setView] = useState("boletas");
  const current = SALES_VIEWS.find((v) => v.id === view) ?? SALES_VIEWS[0];
  return (
    <div className="admin-panel-card bs-sales-ledger">
      <div className="bs-subnav-head">
        <div>
          <h2>Boletas, invitados y cobros</h2>
        </div>
        <div className="bs-subnav" role="tablist" aria-label="Vistas de ventas">
          {SALES_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              onClick={() => setView(v.id)}
              className="bs-subnav-tab"
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div id={`ventas-${current.id}`} role="tabpanel" aria-label={current.label}>
        {view === "boletas" && (
          <div className="bs-sales-list">
            <TicketList
              venueId={venueId}
              eventId={eventId}
              types={types}
              onChanged={onChanged}
              onError={onError}
              title="Boletas emitidas"
              description="Busca por destinatario, filtra por tipo o estado y revisa quién emitió cada boleta."
            />
          </div>
        )}
        {view === "invitados" && (
          <div className="bs-sales-list">
            <div className="bs-guest-import">
              <RsvpSection key={eventId} venueId={venueId} eventId={eventId} eventName={ev.name} />
            </div>
            <TicketList
              venueId={venueId}
              eventId={eventId}
              types={types}
              onChanged={onChanged}
              onError={onError}
              courtesyOnly
              showTypeFilter={false}
              title="Invitados y cortesías"
              description="Lista nominal de cortesías con su emisor, contacto y estado de ingreso."
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
              <span>Recaudo vigente</span>
              <strong className="tnum">{report ? money(report.revenue_cents) : "Sin dato"}</strong>
              <small>Boletas activas e ingresadas.</small>
            </div>
            <div className="bs-metric">
              <span>Emitidas</span>
              <strong className="tnum">{report ? report.issued : "Sin dato"}</strong>
              <small>
                {report
                  ? `${Math.max(0, report.capacity - report.issued)} disponibles de ${report.capacity}.`
                  : "Boletas activas contra el aforo."}
              </small>
            </div>
            <div className="bs-metric">
              <span>Pagadas</span>
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
        )}
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
        <SalesLedger
          ev={ev}
          report={report}
          types={types}
          venueId={venueId}
          eventId={eventId}
          onChanged={onChanged}
          onError={onError}
        />
        <CouponManager
          key={`coupons-${eventId}`}
          venueId={venueId}
          eventId={eventId}
          types={types}
        />
      </div>
    );
  }

  if (section === "equipo") {
    return (
      <div className="admin-workspace-panel">
        <EventTeamPanel venueId={venueId} event={ev} preflight={preflight} />
        <div className="admin-panel-card">
          <h2>Cupos de promotores</h2>
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
        <EventExtrasPanel venueId={venueId} eventId={eventId} types={types} />
        <EventMorePanel venueId={venueId} eventId={eventId} types={types} />
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
