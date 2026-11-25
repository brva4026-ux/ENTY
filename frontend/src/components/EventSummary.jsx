import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useUI } from "../lib/ui";
import { money, plural } from "../lib/format";
import { formatEventTime, eventZone } from "../lib/eventTime";
import { LiveIndicator } from "./Brand";
import EventCover, { eventFullDate } from "./EventCover";
import Icon from "./Icon";
import LineupManager from "./LineupManager";

/** Contexto de una sección: qué evento, cuándo, dónde y qué se hace ahora. */
export function SectionContext({ ev, next }) {
  const tz = eventZone(ev);
  return (
    <div className="bs-section-context">
      <p>
        <strong>{ev.name}</strong>
        <span aria-hidden="true">·</span>
        {eventFullDate(ev)}
        <span aria-hidden="true">·</span>
        {formatEventTime(ev.starts_at, tz)}
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

function Metric({ label, value, note, tone }) {
  return (
    <div className="bs-metric">
      <span>{label}</span>
      <strong className="tnum" data-tone={tone}>
        {value}
      </strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function CheckRow({ ok, label, detail, action, actionLabel }) {
  return (
    <li className={ok ? "is-ok" : "is-warn"}>
      <span className="admin-check-icon" aria-hidden="true">
        {ok ? "✓" : "!"}
      </span>
      <span className="bs-check-copy">
        <strong>{label}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {action && (
        <button type="button" className="btn-mini" onClick={action}>
          {actionLabel}
        </button>
      )}
    </li>
  );
}

function PublicPreview({ ev, onSection, onEdit, editable }) {
  return (
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
          onClick={() => onSection("rentabilidad")}
        >
          Ver rentabilidad
        </button>
        <button
          type="button"
          className="btn-mini"
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
  );
}

function usePublicChannels(ev) {
  const [channels, setChannels] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!["published", "live", "ended"].includes(ev.status)) {
      setChannels(null);
      setError("");
      return undefined;
    }
    let alive = true;
    setChannels(null);
    setError("");
    apiFetch(`/public/events/${ev.id}`)
      .then((data) => alive && setChannels(data))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [ev.id, ev.status]);

  return { channels, error };
}

function CopyPublicLink({ path }) {
  const ui = useUI();
  const url = `${window.location.origin}${path}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      ui.success("Enlace público copiado");
    } catch {
      ui.alert("Copia el enlace público", { message: url });
    }
  }

  return (
    <div className="bs-public-link">
      <code title={url}>{url}</code>
      <button type="button" className="btn-mini" onClick={copy}>
        <Icon name="copy" className="h-3.5 w-3.5" />
        Copiar
      </button>
      <a
        className="btn-mini"
        href={path}
        target="_blank"
        rel="noreferrer"
        data-variant="brand"
      >
        Abrir
      </a>
    </div>
  );
}

function DraftState({ ev, types, busyAction, onAction, onSection, onEdit }) {
  const activeTypes = (types || []).filter((t) => t.is_active !== false);
  const steps = [
    {
      ok: Boolean(ev.location?.trim()),
      label: "Fecha y lugar",
      detail: ev.location
        ? `${eventFullDate(ev)} · ${ev.location}`
        : "Falta confirmar el lugar de la noche.",
      action: onEdit,
      actionLabel: "Editar",
    },
    {
      ok: activeTypes.length > 0,
      label: "Tipos de boleta",
      detail: activeTypes.length
        ? `${activeTypes.length} ${plural(activeTypes.length, "localidad activa", "localidades activas")} · aforo ${ev.capacity}`
        : "Todavía no hay una localidad para vender.",
      action: () => onSection("ventas"),
      actionLabel: "Configurar",
    },
    {
      ok: Boolean(ev.description?.trim()) && Boolean(ev.location?.trim()),
      label: "Ficha pública",
      detail:
        ev.description?.trim() && ev.location?.trim()
          ? "Descripción y lugar listos para publicar."
          : "Completa la descripción y el lugar para que la ficha explique la noche.",
      action: onEdit,
      actionLabel: "Revisar",
    },
  ];

  return (
    <section className="bs-state" data-state="draft" aria-labelledby="bs-state-title">
      <div className="bs-state-head">
        <div>
          <p className="bs-stage">Borrador</p>
          <h2 id="bs-state-title">Prepara tu evento</h2>
          <p>
            Revisa lo esencial antes de publicar. Al hacerlo, la ficha queda
            visible y los promotores con cupo pueden emitir boletas.
          </p>
        </div>
        <div className="bs-state-actions">
          <button
            type="button"
            className="btn-primary bs-primary"
            onClick={() => onAction("publish")}
            disabled={busyAction === "publish"}
          >
            {busyAction === "publish" ? "Publicando…" : "Revisar y publicar"}
          </button>
          <a
            className="bs-secondary"
            href={`/evento/${ev.id}?preview=1`}
            target="_blank"
            rel="noreferrer"
          >
            Abrir vista previa
          </a>
        </div>
      </div>
      <ul className="admin-check-list bs-check-list">
        {steps.map((step) => (
          <CheckRow key={step.label} {...step} />
        ))}
      </ul>
    </section>
  );
}

function PublishedState({ ev, types, allocations, preflight, channels, channelError, onSection, onAction, busyAction }) {
  const activeTypes = (types || []).filter((t) => t.is_active !== false);
  const activeAllocations = (allocations || []).filter((a) => a.is_active !== false);
  const available = activeAllocations.reduce(
    (n, a) => n + Math.max(0, (a.capacity ?? 0) - (a.issued ?? 0)),
    0,
  );
  const publicPath = `/evento/${ev.id}`;
  const online =
    channels == null
      ? channelError
        ? "Sin dato"
        : "Consultando…"
      : channels.payments_enabled
        ? "Habilitada"
        : "No configurada";

  return (
    <section className="bs-state" data-state="published" aria-labelledby="bs-state-title">
      <div className="bs-state-head">
        <div>
          <p className="bs-stage">Publicado</p>
          <h2 id="bs-state-title">Evento publicado</h2>
          <p>
            La ficha ya es pública. Comparte el enlace y termina de preparar la
            puerta antes de abrir.
          </p>
        </div>
        <div className="bs-state-actions">
          <button
            type="button"
            className="btn-primary bs-primary"
            onClick={() => onAction("live")}
            disabled={busyAction === "live"}
          >
            {busyAction === "live" ? "Abriendo…" : "Abrir puertas"}
          </button>
          <button
            type="button"
            className="bs-secondary"
            onClick={() => onSection("equipo")}
          >
            Preparar puerta
          </button>
        </div>
      </div>

      <div className="bs-state-grid">
        <div className="bs-state-block">
          <h3>Enlace público</h3>
          <CopyPublicLink path={publicPath} />
          <p className="bs-state-note">
            La venta pública y la emisión por promotores usan esta misma ficha.
          </p>
        </div>
        <div className="bs-state-block">
          <h3>Canales de venta</h3>
          <dl className="bs-channel-list">
            <div>
              <dt>Ficha pública</dt>
              <dd data-tone="ok">Activa</dd>
            </div>
            <div>
              <dt>Venta online</dt>
              <dd data-tone={online === "Habilitada" ? "ok" : online === "Sin dato" ? "muted" : "warn"}>
                {online}
              </dd>
            </div>
            <div>
              <dt>Emisión por promotores</dt>
              <dd>
                {activeAllocations.length
                  ? `${activeAllocations.length} ${plural(activeAllocations.length, "cupo", "cupos")} · ${available} disponibles`
                  : "Sin cupos asignados"}
              </dd>
            </div>
          </dl>
          <p className="bs-state-note">
            {activeTypes.length
              ? `${activeTypes.length} ${plural(activeTypes.length, "localidad activa", "localidades activas")} para vender.`
              : "Todavía no hay localidades activas."}
          </p>
        </div>
      </div>

      <div className="bs-state-block">
        <h3>Qué falta para abrir la puerta</h3>
        <ul className="admin-check-list bs-check-list">
          <CheckRow
            ok={(preflight?.bouncers ?? 0) > 0}
            label="Personal de puerta"
            detail={
              preflight?.bouncers
                ? `${preflight.bouncers} ${plural(preflight.bouncers, "persona asignada", "personas asignadas")}`
                : "Nadie asignado a la puerta."
            }
            action={() => onSection("equipo")}
            actionLabel="Asignar"
          />
          <CheckRow
            ok={preflight?.door_ready === true}
            label="Escáner activo"
            detail={
              preflight?.door_ready
                ? "El equipo ya abrió su enlace de puerta."
                : "Nadie ha canjeado el enlace de puerta."
            }
            action={() => onSection("equipo")}
            actionLabel="Revisar"
          />
          <CheckRow
            ok={activeTypes.length > 0}
            label="Localidades listas"
            detail={
              activeTypes.length
                ? "Hay al menos un tipo de boleta activo."
                : "Publica al menos una localidad antes de abrir."
            }
            action={() => onSection("ventas")}
            actionLabel="Revisar"
          />
        </ul>
      </div>
    </section>
  );
}

function CashReconciliation({ report, onSection, title = "Cuadre de caja" }) {
  if (!report) return null;
  const payments = report.payments ?? {};
  const refunds = report.refunds ?? {};
  const unfulfilled = payments.unfulfilled_count ?? 0;
  return (
    <div className="bs-state-block">
      <h3>{title}</h3>
      <ul className="bs-payment-list">
        <li>
          <span>Recaudo vigente</span>
          <strong className="tnum">{money(report.revenue_cents)}</strong>
          <small>
            {report.issued} emitidas · {report.redeemed} ingresaron
          </small>
        </li>
        <li>
          <span>Cobros aprobados con boleta</span>
          <strong className="tnum">{money(payments.approved_cents ?? 0)}</strong>
          <small>{payments.approved_count ?? 0} cobros</small>
        </li>
        <li>
          <span>Cobros aprobados sin boleta</span>
          <strong className="tnum">{money(payments.unfulfilled_cents ?? 0)}</strong>
          <small>{unfulfilled} por resolver</small>
        </li>
        <li>
          <span>Cobros pendientes</span>
          <strong className="tnum">{money(payments.pending_cents ?? 0)}</strong>
          <small>{payments.pending_count ?? 0} sin confirmar</small>
        </li>
        <li>
          <span>Reembolsos</span>
          <strong className="tnum">{money(refunds.amount_cents ?? 0)}</strong>
          <small>{refunds.count ?? 0} devoluciones</small>
        </li>
      </ul>
      {unfulfilled > 0 && (
        <p className="bs-state-alert" role="status">
          <Icon name="alert" className="h-4 w-4" aria-hidden="true" />
          {unfulfilled}{" "}
          {plural(unfulfilled, "cobro aprobado sin boleta", "cobros aprobados sin boleta")}
          . Resuélvelos en Ventas antes de cerrar.
        </p>
      )}
      <p className="bs-state-note">
        Contrasta estos totales con los movimientos de{" "}
        <button
          type="button"
          className="admin-inline-link"
          onClick={() => onSection("ventas")}
        >
          Ventas
        </button>{" "}
        y el CSV de cierre.
      </p>
    </div>
  );
}

function ChangeNoticeCard({ notice }) {
  const ui = useUI();
  if (!notice) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${notice.title}: ${notice.message}`);
      ui.success("Aviso copiado");
    } catch {
      ui.error("No se pudo copiar el aviso");
    }
  };
  return (
    <div className="bs-state-block">
      <h3>{notice.title}</h3>
      <p className="bs-state-note">{notice.message}</p>
      <p className="bs-state-note">
        Afecta {notice.affected_tickets}{" "}
        {plural(notice.affected_tickets, "boleta", "boletas")} de{" "}
        {notice.affected_buyers}{" "}
        {plural(notice.affected_buyers, "comprador", "compradores")}. Ya se
        muestra en Mis boletas y en la boleta pública.
      </p>
      <button type="button" className="btn-mini" onClick={copy}>
        Copiar aviso
      </button>
    </div>
  );
}

function NightHealth({ ev, onSection }) {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (ev.status !== "live") return undefined;
    let alive = true;
    const load = () =>
      apiFetch(`/venues/${ev.venue_id}/events/${ev.id}/night-health`)
        .then((data) => {
          if (!alive) return;
          setHealth(data);
          setError("");
        })
        .catch((err) => {
          if (alive) setError(err.message || "No pudimos leer el estado de la noche.");
        });
    load();
    const timer = window.setInterval(load, 30000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [ev.id, ev.status, ev.venue_id]);

  if (ev.status !== "live" || (!health && !error)) return null;

  const stale = health?.stale_devices ?? 0;
  const pending = health?.pending_payments_count ?? 0;
  const unfulfilled = health?.unfulfilled_payments_count ?? 0;
  const incidents = health?.open_incidents ?? 0;
  const lastSeen = health?.last_seen_at
    ? new Date(health.last_seen_at).toLocaleTimeString("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Sin señal";

  return (
    <div className="bs-state-block">
      <h3>Salud de la noche</h3>
      {error ? (
        <p className="bs-state-alert" role="status">
          <Icon name="alert" className="h-4 w-4" aria-hidden="true" />
          {error}
        </p>
      ) : (
        <ul className="bs-payment-list">
          <li>
            <span>Puestos activos</span>
            <strong className="tnum">{health.active_devices}</strong>
            <small>
              {stale
                ? `${stale} sin sincronizar hace más de 10 min`
                : `Última señal ${lastSeen}`}
            </small>
          </li>
          <li>
            <span>Pagos por resolver</span>
            <strong className="tnum">{pending + unfulfilled}</strong>
            <small>
              {money(health.pending_payments_cents + health.unfulfilled_payments_cents)}
              {unfulfilled ? ` · ${unfulfilled} sin boleta` : ""}
            </small>
          </li>
          <li>
            <span>Incidencias abiertas</span>
            <strong className="tnum" data-tone={incidents ? "warn" : undefined}>
              {incidents}
            </strong>
            <small>Casos de puerta sin resolver.</small>
          </li>
        </ul>
      )}

      {stale > 0 && (
        <p className="bs-state-alert" role="status">
          <Icon name="alert" className="h-4 w-4" aria-hidden="true" />
          {stale} {plural(stale, "puesto dejó", "puestos dejaron")} de sincronizar.
          <button type="button" className="admin-inline-link" onClick={() => onSection("equipo")}>
            Revisar equipo
          </button>
        </p>
      )}
      {unfulfilled > 0 && (
        <p className="bs-state-alert" role="status">
          <Icon name="alert" className="h-4 w-4" aria-hidden="true" />
          {unfulfilled} {plural(unfulfilled, "cobro aprobado sin boleta", "cobros aprobados sin boleta")}.
          <button type="button" className="admin-inline-link" onClick={() => onSection("ventas")}>
            Resolver en Ventas
          </button>
        </p>
      )}
      {incidents > 0 && (
        <p className="bs-state-alert" role="status">
          <Icon name="alert" className="h-4 w-4" aria-hidden="true" />
          {incidents} {plural(incidents, "incidencia abierta", "incidencias abiertas")}.
          <button type="button" className="admin-inline-link" onClick={() => onSection("accesos")}>
            Ver incidencias
          </button>
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-mini" onClick={() => onSection("equipo")}>
          Equipo y puestos
        </button>
        <button type="button" className="btn-mini" onClick={() => onSection("ventas")}>
          Pagos
        </button>
        <button type="button" className="btn-mini" onClick={() => onSection("accesos")}>
          Accesos
        </button>
      </div>
    </div>
  );
}

function LiveState({ ev, report, lastUpdated, busyAction, onAction, onSection }) {
  const capacity = report?.capacity ?? ev.capacity;
  const incidents =
    report == null
      ? null
      : (report.door_duplicates ?? 0) + (report.door_rejected ?? 0);
  const duplicates = report?.door_duplicates ?? 0;
  const rejected = report?.door_rejected ?? 0;

  function goIncidents() {
    onSection("accesos");
    window.setTimeout(() => {
      document
        .getElementById("accesos-incidencias")
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 80);
  }

  return (
    <section className="bs-state bs-state--live" data-state="live" aria-labelledby="bs-state-title">
      <div className="bs-state-head">
        <div>
          <p className="bs-stage">
            <span className="dp-live-dot" aria-hidden="true" /> En puerta
          </p>
          <h2 id="bs-state-title">Puerta en vivo</h2>
          <p>
            {report
              ? `${report.redeemed} ${plural(report.redeemed, "ingreso confirmado", "ingresos confirmados")} de ${capacity} de aforo.`
              : "Esperando el primer dato de la puerta."}
          </p>
        </div>
        <div className="bs-state-actions">
          <button type="button" className="btn-primary bs-primary" onClick={goIncidents}>
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

      <div className="bs-state-grid bs-state-grid--metrics">
        <Metric
          label="Ingresos"
          value={report ? report.redeemed : "Sin dato"}
          note={report ? `de ${capacity} de aforo` : undefined}
          tone="ok"
        />
        <Metric
          label="Boletas emitidas"
          value={report ? report.issued : "Sin dato"}
          note={report ? `${report.pending ?? 0} sin ingreso` : undefined}
        />
        <Metric
          label="Incidencias"
          value={incidents == null ? "Sin dato" : incidents}
          note={
            incidents == null
              ? "El servidor aún no reporta."
              : incidents === 0
                ? "Sin duplicados ni rechazos."
                : `${duplicates} duplicados · ${rejected} rechazos`
          }
          tone={incidents > 0 ? "warn" : undefined}
        />
        <div className="bs-metric">
          <span>Última actualización</span>
          <strong>
            {lastUpdated ? (
              <LiveIndicator live lastUpdated={lastUpdated} />
            ) : (
              "Sin dato"
            )}
          </strong>
          <small>Se actualiza sola mientras la puerta está abierta.</small>
        </div>
      </div>

      <CashReconciliation report={report} onSection={onSection} title="Cuadre en vivo" />
      <NightHealth ev={ev} onSection={onSection} />

      <p className="bs-state-note">
        El ritmo de la noche, el registro de escaneos y el cierre están en{" "}
        <button type="button" className="admin-inline-link" onClick={() => onSection("accesos")}>
          Accesos
        </button>
        .
      </p>
    </section>
  );
}

function EndedState({ report, onSection, onCloseNight }) {
  const pending = report?.pending ?? null;
  const incidents =
    report == null
      ? null
      : (report.door_duplicates ?? 0) + (report.door_rejected ?? 0);
  const unfulfilled = report?.payments?.unfulfilled_count ?? 0;
  const provisional =
    report != null &&
    ((pending ?? 0) > 0 || (incidents ?? 0) > 0 || unfulfilled > 0);

  return (
    <section className="bs-state" data-state="ended" aria-labelledby="bs-state-title">
      <div className="bs-state-head">
        <div>
          <p className="bs-stage">Finalizado</p>
          <h2 id="bs-state-title">Cierre de la noche</h2>
          <p>
            {report
              ? `${report.redeemed} de ${report.issued} boletas emitidas registraron ingreso.`
              : "Todavía no hay cifras de cierre para mostrar."}
          </p>
        </div>
        <div className="bs-state-actions">
          <button type="button" className="btn-primary bs-primary" onClick={() => onSection("accesos")}>
            Ver cierre
          </button>
          <button
            type="button"
            className="bs-secondary"
            onClick={onCloseNight}
          >
            <Icon name="download" className="h-4 w-4" aria-hidden="true" />
            Descargar cierre
          </button>
        </div>
      </div>

      <div className="bs-state-grid bs-state-grid--metrics">
        <Metric label="Emitidas" value={report ? report.issued : "Sin dato"} />
        <Metric label="Ingresaron" value={report ? report.redeemed : "Sin dato"} tone="ok" />
        <Metric
          label="Sin ingreso"
          value={pending == null ? "Sin dato" : pending}
          tone={pending > 0 ? "warn" : undefined}
        />
        <Metric label="Recaudo vigente" value={report ? money(report.revenue_cents) : "Sin dato"} />
      </div>

      <CashReconciliation report={report} onSection={onSection} title="Cuadre de cierre" />

      {provisional ? (
        <p className="bs-state-alert" role="status">
          <Icon name="alert" className="h-4 w-4" aria-hidden="true" />
          Cierre provisional:{" "}
          {[
            pending > 0
              ? `${pending} ${plural(pending, "boleta activa sin ingreso registrado", "boletas activas sin ingreso registrado")}`
              : null,
            incidents > 0
              ? `${incidents} ${plural(incidents, "incidencia de puerta", "incidencias de puerta")}`
              : null,
            unfulfilled > 0
              ? `${unfulfilled} ${plural(unfulfilled, "cobro aprobado sin boleta", "cobros aprobados sin boleta")}`
              : null,
          ]
            .filter(Boolean)
            .join(" y ")}
          . Revisa Accesos y Ventas antes de conciliar.
        </p>
      ) : (
        <p className="bs-state-note">
          Cierre completo con los datos disponibles: no quedan boletas activas
          sin ingreso ni incidencias de puerta.
        </p>
      )}

      <p className="bs-state-note">
        Los pagos, reembolsos y anulaciones se revisan en{" "}
        <button type="button" className="admin-inline-link" onClick={() => onSection("ventas")}>
          Ventas
        </button>
        .
      </p>
    </section>
  );
}

function CancelledState({ report, onSection }) {
  const payments = report?.by_payment_method ?? [];
  return (
    <section className="bs-state" data-state="cancelled" aria-labelledby="bs-state-title">
      <div className="bs-state-head">
        <div>
          <p className="bs-stage">Cancelado</p>
          <h2 id="bs-state-title">Evento cancelado</h2>
          <p>
            No se venden boletas nuevas ni se validan ingresos en la puerta.
            Revisa las boletas y los movimientos de pago ya registrados.
          </p>
        </div>
        <div className="bs-state-actions">
          <button type="button" className="btn-primary bs-primary" onClick={() => onSection("ventas")}>
            Ver boletas y cobros
          </button>
        </div>
      </div>

      <div className="bs-state-grid bs-state-grid--metrics">
        <Metric label="Boletas emitidas" value={report ? report.issued : "Sin dato"} />
        <Metric label="Ingresaron" value={report ? report.redeemed : "Sin dato"} />
        <Metric
          label="Anuladas"
          value={report ? report.voided : "Sin dato"}
          note={report ? `${report.refunded ?? 0} reembolsadas` : undefined}
          tone={report?.voided > 0 ? "warn" : undefined}
        />
        <Metric label="Recaudo vigente" value={report ? money(report.revenue_cents) : "Sin dato"} />
      </div>

      <CashReconciliation report={report} onSection={onSection} title="Cuadre de caja" />

      <div className="bs-state-block">
        <h3>Pagos registrados</h3>
        {payments.length ? (
          <ul className="bs-payment-list">
            {payments.map((p) => (
              <li key={p.payment_method ?? "sin-medio"}>
                <span>{p.payment_method ?? "Sin medio registrado"}</span>
                <strong className="tnum">{money(p.revenue_cents)}</strong>
                <small>{p.tickets} {plural(p.tickets, "boleta", "boletas")}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="bs-state-note">No hay movimientos de pago registrados.</p>
        )}
      </div>
    </section>
  );
}

export default function EventSummary({
  ev,
  report,
  types,
  allocations,
  preflight,
  isLive,
  lastUpdated,
  busyAction,
  onAction,
  onSection,
  onEdit,
  editable,
  onCloseNight,
  venueId,
  eventId,
}) {
  const { channels, error: channelError } = usePublicChannels(ev);
  const nextByState = {
    draft: "Completa la fecha, las localidades y la ficha; después publica.",
    published: "Comparte el enlace y prepara a la gente que abrirá la puerta.",
    live: "Sigue los ingresos y atiende las incidencias mientras la puerta está abierta.",
    ended: "Revisa el cierre, descarga las cifras y concilia los pagos.",
    cancelled: "Consulta el estado real de las boletas y los pagos.",
  };

  return (
    <div className="admin-workspace-panel">
      <SectionContext ev={ev} next={nextByState[ev.status]} />
      <ChangeNoticeCard notice={ev.change_notice} />

      {ev.status === "draft" && (
        <DraftState
          ev={ev}
          types={types}
          busyAction={busyAction}
          onAction={onAction}
          onSection={onSection}
          onEdit={onEdit}
        />
      )}
      {ev.status === "published" && (
        <PublishedState
          ev={ev}
          types={types}
          allocations={allocations}
          preflight={preflight}
          channels={channels}
          channelError={channelError}
          onSection={onSection}
          onAction={onAction}
          busyAction={busyAction}
        />
      )}
      {isLive && (
        <LiveState
          ev={ev}
          report={report}
          lastUpdated={lastUpdated}
          busyAction={busyAction}
          onAction={onAction}
          onSection={onSection}
        />
      )}
      {ev.status === "ended" && (
        <EndedState
          report={report}
          onSection={onSection}
          onCloseNight={onCloseNight}
        />
      )}
      {ev.status === "cancelled" && (
        <CancelledState report={report} onSection={onSection} />
      )}

      <PublicPreview
        ev={ev}
        onSection={onSection}
        onEdit={onEdit}
        editable={editable}
      />

      <LineupManager venueId={venueId} eventId={eventId} />
    </div>
  );
}
