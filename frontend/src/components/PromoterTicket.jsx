import { useEffect, useState } from "react";
import Icon from "./Icon";
import { eventDate } from "../lib/format";

/** QR de una boleta emitida. El token es la credencial: no se cachea ni se
 *  escribe en el DOM más allá de la imagen generada. */
function useQr(token) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!token) {
      setSrc("");
      return;
    }
    let alive = true;
    import("qrcode")
      .then((QR) =>
        QR.toDataURL(token, {
          width: 320,
          margin: 1,
          errorCorrectionLevel: "M",
          color: { dark: "#241d16", light: "#ffffff" },
        }),
      )
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(""));
    return () => {
      alive = false;
    };
  }, [token]);
  return src;
}

export function PromoterTicketCard({
  token,
  ticketId,
  name,
  eventName,
  venueName,
  ticketType,
  startsAt,
  compact = false,
}) {
  const qr = useQr(token);
  return (
    <article className={`promoter-ticket${compact ? " is-compact" : ""}`}>
      <div className="promoter-ticket-head">
        <div>
          <p className="promoter-ticket-label">{venueName || "Enty"}</p>
          <h3 className="promoter-ticket-event">{eventName}</h3>
          <p className="promoter-ticket-name">{name || "Invitado"}</p>
          <div className="promoter-ticket-meta">
            {ticketType && <span>{ticketType}</span>}
            {startsAt && <span>{eventDate(startsAt)}</span>}
          </div>
        </div>
        <div className="promoter-ticket-qr" aria-label="Código QR de la boleta">
          {qr ? (
            <img src={qr} alt={`Código QR de la boleta de ${name || "el invitado"}`} />
          ) : (
            <div className="promoter-ticket-qr-empty" aria-hidden="true">
              <Icon name="qr" />
            </div>
          )}
        </div>
      </div>
      <div className="promoter-ticket-perf" aria-hidden="true" />
      <div className="promoter-ticket-foot">
        <span>Boleta <b>#{String(ticketId ?? "").padStart(4, "0")}</b></span>
        <span>Presenta este QR en la puerta</span>
      </div>
    </article>
  );
}

export function PromoterTicketFullscreen({ ticket, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!ticket) return null;
  return (
    <div
      className="promoter-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label="Boleta para mostrar en la puerta"
    >
      <div className="promoter-fullscreen-head">
        <h2>Boleta</h2>
        <button type="button" className="promoter-btn promoter-btn--sm" onClick={onClose}>
          <Icon name="close" aria-hidden="true" />
          Cerrar
        </button>
      </div>
      <PromoterTicketCard
        token={ticket.raw_token}
        ticketId={ticket.ticket_id}
        name={ticket.customer_name}
        eventName={ticket.event_name}
        venueName={ticket.venue_name}
        ticketType={ticket.ticket_type}
        startsAt={ticket.event_starts_at}
      />
      <p className="promoter-hint" style={{ textAlign: "center", marginTop: 12 }}>
        Sube el brillo de la pantalla. El QR se valida una sola vez en la puerta.
      </p>
    </div>
  );
}
