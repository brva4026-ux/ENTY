import Icon from "./Icon";
import TicketPreview from "./TicketPreview";

/**
 * Boleta recien emitida: QR, enlace del invitado y envio por WhatsApp.
 *
 * El invitado no puede escanear un texto, asi que se le manda el ENLACE a su
 * boleta (`/t#<token>`), donde ve el QR. El token va en el fragmento, que el
 * navegador no envia al servidor: no queda en logs ni en el Referer.
 *
 * Lo comparten el panel del promotor y el del admin: el envio es identico y
 * duplicarlo haria que un arreglo en el mensaje quedara a medias.
 */
export default function IssuedTicket({ ticket, eventName }) {
  if (!ticket) return null;

  const ticketUrl = `${window.location.origin}/t#${encodeURIComponent(ticket.raw_token)}`;
  const phone = (ticket.customer_phone ?? "").replace(/\D/g, "");
  const waLink = phone
    ? `https://wa.me/${phone}?text=${encodeURIComponent(
        `Tu boleta está lista 🎟️\nEvento: ${eventName ?? ""}\nNombre: ${
          ticket.customerName ?? ""
        }\nÁbrela aquí y muestra el QR en la entrada:\n${ticketUrl}`
      )}`
    : null;

  return (
    <div className="animate-rise space-y-4">
      <TicketPreview
        rawToken={ticket.raw_token}
        ticketId={ticket.ticket_id}
        name={ticket.customerName || "Asistente"}
        eventName={eventName}
      />
      <div className="rounded-lg bg-slate-800/60 p-3 ring-1 ring-slate-700/50">
        <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Icon name="shield" className="h-3.5 w-3.5" />
          Enlace del invitado (ábrelo y verá su QR)
        </p>
        <p className="break-all font-mono text-xs text-slate-200">{ticketUrl}</p>
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(ticketUrl)}
          className="chip tap-target mt-2"
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          Copiar enlace
        </button>
      </div>
      {waLink && (
        <a
          href={waLink}
          target="_blank"
          rel="noreferrer"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 py-3 font-bold text-white shadow-lg shadow-emerald-500/25 transition hover:bg-emerald-400"
        >
          <Icon name="whatsapp" className="h-5 w-5" />
          Enviar por WhatsApp
        </a>
      )}
    </div>
  );
}