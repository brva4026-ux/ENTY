import { useState } from "react";
import { publicTicketPageUrl } from "../lib/api";
import { ticketWaMessage, waLink } from "../lib/whatsapp";
import Icon from "./Icon";
import TicketPreview from "./TicketPreview";

/**
 * Boleta recien emitida: QR, enlace del invitado, envio por WhatsApp y el
 * codigo de respaldo. Lo comparten el panel del promotor y el del admin: la
 * entrega es identica y duplicarla haria que un arreglo del mensaje quedara a
 * medias en uno de los dos.
 *
 * `ticket.raw_token` solo existe en la respuesta de emision/reemision: la DB
 * nunca guarda el token en claro, asi que un item del historial no tiene
 * enlace hasta que se reemite.
 */
export default function IssuedTicket({ ticket, eventName }) {
  const [copied, setCopied] = useState(false);
  if (!ticket) return null;

  const ticketUrl =
    ticket.raw_token != null ? publicTicketPageUrl(ticket.raw_token) : null;

  // waLink devuelve null si el telefono viene incompleto: mejor no pintar el
  // boton que abrir un chat equivocado.
  const waHref = waLink(
    ticket.customerPhone,
    ticketWaMessage({
      customerName: ticket.customerName,
      eventName,
      ticketId: ticket.ticket_id,
      url: ticketUrl,
    }),
  );

  async function copyUrl() {
    if (!ticketUrl) return;
    await navigator.clipboard.writeText(ticketUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      className="animate-rise space-y-4"
      key={ticket.raw_token ?? ticket.ticket_id}
    >
      <a href={ticketUrl} target="_blank" rel="noreferrer" className="block">
        <TicketPreview
          rawToken={ticket.raw_token}
          ticketId={ticket.ticket_id}
          name={ticket.customerName || "Asistente"}
          eventName={eventName}
        />
      </a>

      {waHref && (
        <a
          href={waHref}
          target="_blank"
          rel="noreferrer"
          className="flex w-full items-center justify-center rounded-xl bg var(--e-green-500) py-3 font-semibold text var(--e-paper) transition hover:bg var(--e-green-400)"
        >
          <Icon name="whatsapp" className="h-5 w-5" />
          Enviar por WhatsApp
        </a>
      )}

      {/* Lo que se le entrega al invitado: abre el QR sin sesión. */}
      <div className="rounded-lg bg var(--e-panel-600) p-3 ring-1 ring var(--e-panel-border)">
        <p className="mb-1 text-xs font-medium text var(--e-text-subtle)">
          Enlace de la boleta (el invitado abre aquí su QR)
        </p>
        <p className="break-all font-mono text-xs text var(--e-text-on-surface-low)">{ticketUrl}</p>
        <div className="mt-2 flex gap-2">
          <a
            href={ticketUrl}
            target="_blank"
            rel="noreferrer"
            className="btn-ghost flex-1 text-xs font-bold"
          >
            Ver boleta
          </a>
          <button
            type="button"
            onClick={copyUrl}
            className="btn-ghost flex-1 text-xs font-bold"
          >
            {copied ? "¡Enlace copiado!" : "Copiar enlace"}
          </button>
        </div>
      </div>

      <details className="list-row rounded-lg p-3">
        <summary className="cursor-pointer text-xs font-medium text var(--e-text-caption)">
          Código de respaldo (validar sin cámara)
        </summary>
        <p className="mt-2 break-all font-mono text-xs text var(--e-text-subtle)">
          {ticket.raw_token}
        </p>
      </details>
    </div>
  );
}
