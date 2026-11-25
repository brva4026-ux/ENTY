import { useEffect, useState } from "react";
import { fetchTicketHistory } from "../lib/api";
import { money } from "../lib/format";
import { useDialogA11y } from "../lib/useDialogA11y";
import Icon from "./Icon";

const STATUS = {
  issued: { label: "Activa", tone: "ok" },
  redeemed: { label: "Redimida", tone: "info" },
  voided: { label: "Anulada", tone: "danger" },
  refunded: { label: "Reembolsada", tone: "warn" },
};

const PAYMENT = {
  approved: "Pagado y conciliado",
  pending: "Pendiente de pago",
  paid_unfulfilled: "Pagado sin boleta",
  declined: "Rechazado",
  voided: "Anulado",
  expired: "Expirado",
};

const KIND_ICON = {
  issued: "ticket",
  payment_created: "money",
  payment_approved: "check",
  payment_review: "alert",
  payment_closed: "close",
  reissued: "qr",
  contact_updated: "edit",
  scan_granted: "check",
  scan_duplicate: "alert",
  scan_rejected: "close",
  returned: "undo",
  refunded: "money",
  incident: "flag",
  incident_resolved: "check",
  incident_comment: "list",
  voided: "close",
};

const KIND_TONE = {
  issued: "ok",
  payment_approved: "ok",
  payment_created: "info",
  payment_review: "danger",
  payment_closed: "danger",
  reissued: "info",
  contact_updated: "info",
  scan_granted: "ok",
  scan_duplicate: "warn",
  scan_rejected: "danger",
  returned: "warn",
  refunded: "warn",
  incident: "warn",
  incident_resolved: "ok",
  incident_comment: "info",
  voided: "danger",
};

const PILL_TONE = {
  ok: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
  info: "bg-sky-500/15 text-sky-300 ring-sky-500/40",
  warn: "bg-amber-500/15 text-amber-300 ring-amber-500/40",
  danger: "bg-red-500/15 text-red-300 ring-red-500/40",
};

const DOT_TONE = {
  ok: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
  info: "bg-sky-500/15 text-sky-300 ring-sky-500/40",
  warn: "bg-amber-500/15 text-amber-300 ring-amber-500/40",
  danger: "bg-red-500/15 text-red-300 ring-red-500/40",
};

function when(value) {
  return new Date(value).toLocaleString("es-CO", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Expediente operativo de una boleta.
 *
 * Es la vista que faltaba para responder en mostrador, sin saltar entre
 * pestañas: cómo se pagó, quién la emitió, si se reemitió, si entró y qué
 * incidencias tuvo. Los datos de dinero y contacto solo llegan si el rol
 * tiene permiso; el servidor decide, no el cliente.
 */
export default function TicketHistoryModal({ venueId, eventId, ticketId, onClose }) {
  const { dialogRef, titleId } = useDialogA11y({ onClose });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetchTicketHistory(venueId, eventId, ticketId)
      .then((out) => alive && setData(out))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [venueId, eventId, ticketId]);

  const status = data ? STATUS[data.status] ?? STATUS.issued : null;

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex items-end justify-center overflow-y-auto p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="dialog-panel my-auto max-w-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <span className="dialog-grab" aria-hidden="true" />
        <div className="dialog-head">
          <div className="min-w-0">
            <p id={titleId} className="dialog-title">
              Historial de la boleta #{ticketId}
            </p>
            <p className="dialog-sub">
              {data ? `${data.customer_name} · ${data.ticket_type}` : "Cargando expediente…"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label="Cerrar"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        <div className="dialog-body">
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          {!error && !data && (
            <div className="space-y-2">
              <div className="skeleton h-16" />
              <div className="skeleton h-24" />
            </div>
          )}
          {data && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-2xs font-bold uppercase tracking-wide ring-1 ${PILL_TONE[status.tone]}`}
                >
                  {status.label}
                </span>
                <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-2xs font-semibold text-zinc-300 ring-1 ring-zinc-700">
                  {data.ticket_type}
                </span>
                <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-2xs font-semibold text-zinc-300 ring-1 ring-zinc-700">
                  {data.price_cents > 0 ? money(data.price_cents) : "Cortesía"}
                </span>
                {data.payment_method && (
                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-2xs font-semibold text-zinc-300 ring-1 ring-zinc-700">
                    {data.payment_method === "online"
                      ? "Pago en línea"
                      : data.payment_method}
                  </span>
                )}
                {data.redeemed_at && (
                  <span className={`rounded-full px-2 py-0.5 text-2xs font-bold ring-1 ${PILL_TONE.info}`}>
                    Ingresó {when(data.redeemed_at)}
                    {data.redeemed_by_name ? ` · ${data.redeemed_by_name}` : ""}
                  </span>
                )}
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                  <p className="text-2xs font-bold uppercase tracking-wide text-zinc-500">
                    Asistente
                  </p>
                  <p className="mt-1 text-sm font-semibold text-zinc-100">
                    {data.customer_name}
                  </p>
                  {data.customer_phone && (
                    <p className="text-xs text-zinc-400">{data.customer_phone}</p>
                  )}
                  {data.customer_email && (
                    <p className="text-xs text-zinc-400">{data.customer_email}</p>
                  )}
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                  <p className="text-2xs font-bold uppercase tracking-wide text-zinc-500">
                    Cobro
                  </p>
                  {data.payment ? (
                    <>
                      <p className="mt-1 text-sm font-semibold text-zinc-100">
                        {PAYMENT[data.payment.status] ?? data.payment.status}
                      </p>
                      <p className="tnum text-xs text-zinc-400">
                        {money(data.payment.amount_in_cents)} · {data.payment.reference}
                      </p>
                      {data.payment.fulfillment_error && (
                        <p className="mt-1 text-2xs text-red-300">
                          {data.payment.fulfillment_error}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-zinc-400">
                      Sin cobro en línea asociado.
                    </p>
                  )}
                </div>
              </div>

              <ol className="mt-4 space-y-0" aria-label="Línea de tiempo de la boleta">
                {data.timeline.map((entry) => (
                  <li key={entry.id} className="flex gap-3 pb-3">
                    <span
                      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ${DOT_TONE[KIND_TONE[entry.kind] ?? "info"]}`}
                    >
                      <Icon
                        name={KIND_ICON[entry.kind] ?? "list"}
                        className="h-3.5 w-3.5"
                      />
                    </span>
                    <div className="min-w-0 flex-1 border-b border-zinc-800/70 pb-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                        <p className="text-sm font-semibold text-zinc-100">
                          {entry.title}
                        </p>
                        <time
                          dateTime={entry.at}
                          className="tnum text-2xs text-zinc-500"
                        >
                          {when(entry.at)}
                        </time>
                      </div>
                      {entry.detail && (
                        <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
                          {entry.detail}
                        </p>
                      )}
                      <p className="mt-0.5 text-2xs text-zinc-500">
                        {entry.actor_name
                          ? `Por ${entry.actor_name}`
                          : entry.actor_role
                            ? `Por ${entry.actor_role}`
                            : "Sin actor registrado"}
                        {entry.amount_cents != null && entry.amount_cents > 0
                          ? ` · ${money(entry.amount_cents)}`
                          : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>

        <div className="dialog-foot dialog-foot--center">
          <button type="button" onClick={onClose} className="btn-primary text-xs font-bold">
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
