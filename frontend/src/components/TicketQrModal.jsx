import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { publicTicketPageUrl } from "../lib/api";
import { ticketWaMessage, waLink } from "../lib/whatsapp";
import Icon from "./Icon";
import { useDialogA11y } from "../lib/useDialogA11y";

/**
 * QR de una boleta vista desde el admin.
 *
 * Seguridad del modelo (AGENTS.md): la DB guarda SOLO el SHA-256 del token,
 * el token crudo se entrega una vez y no se puede "leer" después. Por eso
 * VER el QR de una boleta existente exige rotarlo (reissue): mismo
 * ticket_id, token nuevo, el anterior muere en el acto. Este modal explica
 * eso antes de hacerlo y muestra el QR del token fresco, que es único y
 * queda asociado al asistente mientras el evento esté abierto.
 */
export default function TicketQrModal({ ticket, onClose }) {
  const { dialogRef, titleId } = useDialogA11y({ onClose });
  const [qr, setQr] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!ticket?.raw_token) return;
    QRCode.toDataURL(ticket.raw_token, {
      width: 640,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then(setQr)
      .catch(() => setError("No se pudo generar el QR"));
  }, [ticket?.raw_token]);

  const url = ticket?.raw_token ? publicTicketPageUrl(ticket.raw_token) : "";

  // Entrega por WhatsApp: el mismo mensaje que manda el promotor tras emitir.
  // Si el telefono no sirve para wa.me (corto/sin pais), el anchor no se pinta
  // y queda solo copiar/abrir — nunca un chat con número truncado.
  const waHref = ticket
    ? waLink(
        ticket.customer_phone,
        ticketWaMessage({
          customerName: ticket.customer_name,
          eventName: ticket.event_name,
          ticketId: ticket.id,
          url,
        }),
      )
    : null;

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* el enlace es visible para copiar a mano */
    }
  }

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex items-end justify-center overflow-y-auto p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="dialog-panel my-auto max-w-sm text-center"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <span className="dialog-grab" aria-hidden="true" />
        <div className="dialog-head">
          <div className="min-w-0 text-left">
            <p id={titleId} className="dialog-title">
              Boleta #{ticket?.id}
            </p>
            <p className="dialog-sub">
              {ticket?.customer_name}
              {ticket?.type_name ? ` · ${ticket.type_name}` : ""}
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
          {error ? (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          ) : qr ? (
            <img
              src={qr}
              alt={`QR de la boleta #${ticket?.id}`}
              className="mx-auto h-56 w-56 rounded-lg bg-white p-2"
            />
          ) : (
            <div className="skeleton mx-auto h-56 w-56 rounded-lg" />
          )}

          <p className="mt-3 text-2xs leading-relaxed text-zinc-500">
            Este QR es único y quedó asociado a {ticket?.customer_name}. Si se
            vuelve a emitir, este deja de funcionar.
          </p>
        </div>

        <div className="dialog-foot dialog-foot--center">
          {waHref && (
            <a
              href={waHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold text-emerald-300 ring-1 ring-emerald-500/40 transition hover:bg-emerald-500/10"
            >
              <Icon name="whatsapp" className="h-4 w-4" />
              Enviar por WhatsApp
            </a>
          )}
          <button
            type="button"
            onClick={copyUrl}
            className={`btn-ghost text-xs font-bold ${copied ? "btn-success" : ""}`}
          >
            {copied ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3.5 w-3.5"
                aria-hidden="true"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : null}
            {copied ? "Enlace copiado" : "Copiar enlace"}
          </button>
          {/* Fuera del <button>: los hijos de un botón se aplanan en el árbol
              de accesibilidad y una región viva ahí dentro no se anuncia. */}
          <span className="sr-only" role="status">
            {copied ? "Enlace copiado al portapapeles" : ""}
          </span>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="btn-primary text-xs font-bold"
          >
            Abrir boleta
          </a>
        </div>
      </div>
    </div>
  );
}
