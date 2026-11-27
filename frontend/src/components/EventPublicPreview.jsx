import { useMemo, useState } from "react";
import Icon from "./Icon";
import { EntySymbol } from "./Brand";
import { useDialogA11y } from "../lib/useDialogA11y";
import { formatEventDate, formatEventTime, eventZone } from "../lib/eventTime";
import { money } from "../lib/format";
import { placeLabel } from "../lib/placeLabel";

/**
 * Vista previa móvil del editor de eventos.
 *
 * No es un iframe: la ficha real vive detrás de `?preview=1` y la CSP de
 * Vercel prohíbe embeberla. Este marco reproduce los datos que el organizador
 * está editando para revisar identidad, textos y contacto antes de guardar.
 */
export default function EventPublicPreview({
  event,
  ticketTypes = [],
  onClose,
}) {
  const { dialogRef, titleId } = useDialogA11y({ onClose });
  const [badFlyer, setBadFlyer] = useState(false);

  const view = useMemo(() => {
    if (!event) return null;
    const tz = eventZone(event);
    const paid = (ticketTypes || []).filter(
      (t) => !t.is_courtesy && t.price_cents != null && t.price_cents > 0,
    );
    const minPrice = paid.length
      ? Math.min(...paid.map((t) => t.price_cents))
      : event.price_cents ?? null;
    const rows = (ticketTypes || []).length
      ? ticketTypes
      : [
          {
            id: "general",
            name: "Entrada general",
            price_cents: event.price_cents ?? null,
            is_courtesy: minPrice == null,
            sold_out: false,
          },
        ];
    return {
      date: formatEventDate(event.starts_at, tz),
      time: formatEventTime(event.starts_at, tz),
      minPrice,
      rows,
      lineup: event.lineup || [],
    };
  }, [event, ticketTypes]);

  if (!event || !view) return null;

  const hasFlyer = Boolean(event.flyer_url) && !badFlyer;
  const venue = event.venue || event.venue_name || "";
  const place = placeLabel(venue, event.location);
  const contact = event.contact_name || venue || "el organizador";
  const cta =
    event.status === "draft"
      ? "Vista previa · la venta se habilita al publicar"
      : view.minPrice == null
        ? event.contact_phone
          ? "Encargar por WhatsApp"
          : "Entrada gratuita"
        : event.contact_phone
          ? "Comprar boleto o encargar por WhatsApp"
          : "Comprar boleto";

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-[90] flex items-end justify-center overflow-y-auto p-4 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="dialog-panel my-auto w-full max-w-lg"
      >
        <div className="dialog-head">
          <div className="min-w-0">
            <h3 id={titleId} className="dialog-title">
              Vista previa móvil
            </h3>
            <p className="dialog-sub">
              Así verá el público la ficha. Los datos sin guardar no llegan a
              la página publicada.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label="Cerrar vista previa"
          >
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>

        <div className="dialog-body">
          <div className="evd-preview-phone">
            <div className="evd-preview-screen">
              <p className="evd-preview-cat">
                {event.category || "Evento"}
              </p>
              <h4 className="evd-preview-title">
                {event.name || "Evento sin nombre"}
              </h4>
              <p className="evd-preview-fact">
                <Icon name="calendar" className="h-4 w-4" />
                <span>
                  {view.date}
                  {view.time ? ` · ${view.time}` : ""}
                </span>
              </p>
              <p className="evd-preview-fact">
                <Icon name="door" className="h-4 w-4" />
                <span>{place || "Lugar por confirmar"}</span>
              </p>

              <div className="evd-preview-poster">
                {hasFlyer ? (
                  <img
                    src={event.flyer_url}
                    alt={`Afiche de ${event.name}`}
                    onError={() => setBadFlyer(true)}
                    decoding="async"
                  />
                ) : (
                  <span className="evd-preview-brand" aria-hidden="true">
                    <EntySymbol size={38} />
                    <span>Enty</span>
                  </span>
                )}
              </div>

              <div className="evd-preview-tickets">
                <p className="evd-preview-label">Boletas</p>
                <ul>
                  {view.rows.map((t) => (
                    <li key={t.id ?? t.name}>
                      <span>{t.name}</span>
                      <strong>
                        {t.is_courtesy || t.price_cents == null
                          ? "Gratis"
                          : money(t.price_cents)}
                      </strong>
                    </li>
                  ))}
                </ul>
                <span className="evd-preview-cta">{cta}</span>
              </div>

              {event.video_url && (
                <div className="evd-preview-video">
                  <Icon name="eye" className="h-4 w-4" />
                  Ver video del evento
                </div>
              )}

              {event.description && (
                <div className="evd-preview-block">
                  <p className="evd-preview-label">Sobre el evento</p>
                  <p className="evd-preview-prose">{event.description}</p>
                </div>
              )}

              {view.lineup.length > 0 && (
                <div className="evd-preview-block">
                  <p className="evd-preview-label">
                    Artistas y programación
                  </p>
                  <p className="evd-preview-prose">
                    {view.lineup.map((a) => a.name).filter(Boolean).join(" · ")}
                  </p>
                </div>
              )}

              {(venue || event.location) && (
                <div className="evd-preview-block">
                  <p className="evd-preview-label">Lugar</p>
                  <p className="evd-preview-prose">
                    {place || "Lugar por confirmar"}
                  </p>
                  {event.location_url && (
                    <p className="evd-preview-link">Cómo llegar</p>
                  )}
                </div>
              )}

              {event.contact_phone && (
                <div className="evd-preview-block">
                  <p className="evd-preview-label">Contacto</p>
                  <p className="evd-preview-prose">
                    Contactar al organizador · {contact}
                  </p>
                </div>
              )}

              <p className="evd-preview-share">Compartir evento</p>
            </div>
          </div>
          <p className="mt-3 text-center text-2xs text-zinc-500">
            La acción de boletas se ajusta al pago en línea, al WhatsApp del
            organizador o a la lista de espera según el estado real del evento.
          </p>
        </div>
      </div>
    </div>
  );
}
