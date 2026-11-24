import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Icon from "../../components/Icon";
import TransitionLink from "../../components/TransitionLink";
import { PromoterAlert, PromoterEmpty, PromoterSkeleton } from "../../components/PromoterUI";
import { useAuth } from "../../lib/auth";
import { activeVenueId } from "../../lib/venue";
import { fetchPromoterEvents } from "../../lib/api";
import { eventDate, money } from "../../lib/format";
import { eventStatusLabel, saleReasonLabel } from "../../lib/promoter";

const FILTERS = [
  { id: "all", label: "Todos" },
  { id: "selling", label: "En venta" },
  { id: "upcoming", label: "Próximos" },
  { id: "closed", label: "Cerrados" },
];

function EventCover({ event }) {
  const date = event.starts_at ? new Date(event.starts_at) : null;
  const valid = date && !Number.isNaN(date.getTime());
  return (
    <div className="promoter-cover" data-cat={event.category || "Fiesta"}>
      {event.flyer_url ? <img src={event.flyer_url} alt="" loading="lazy" decoding="async" /> : null}
      <span className="promoter-cover-label">{event.category || "Evento"}</span>
      {valid && (
        <span className="promoter-cover-date">
          <b>{date.getDate()}</b>
          <span>{date.toLocaleDateString("es-CO", { month: "short" })}</span>
        </span>
      )}
    </div>
  );
}

function EventCard({ event }) {
  const nav = useNavigate();
  const live = event.status === "live";
  const closed = event.status === "ended" || event.status === "cancelled";
  return (
    <article className={`promoter-event-card${live ? " is-live" : ""}${closed ? " is-closed" : ""}`}>
      <EventCover event={event} />
      <div className="promoter-card-body">
        <div className="promoter-card-top">
          <div>
            <h2 className="promoter-card-title">
              <TransitionLink to={`/promotor/evento/${event.id}`}>{event.name}</TransitionLink>
            </h2>
            <p className="promoter-card-org">{event.venue_name}</p>
          </div>
          <span className={`promoter-status promoter-status--${live ? "ok" : closed ? "danger" : "neutral"}`}>
            {eventStatusLabel(event.status)}
          </span>
        </div>

        <div className="promoter-card-meta">
          <span><Icon name="calendar" className="h-3 w-3" aria-hidden="true" />{eventDate(event.starts_at)}</span>
          {event.location && <span><Icon name="door" className="h-3 w-3" aria-hidden="true" />{event.location}</span>}
        </div>

        <div className="promoter-card-stats">
          <span className="promoter-stat"><b>{event.my_issued}</b><span>Emitidas</span></span>
          <span className="promoter-stat"><b>{event.my_capacity}</b><span>Mi cupo</span></span>
          <span className="promoter-stat"><b>{event.link_sold}</b><span>Por link</span></span>
        </div>

        <div className="promoter-availability" aria-label="Disponibilidad por tipo">
          {event.ticket_types.length === 0 && <span>Sin tipos de boleta</span>}
          {event.ticket_types.map((t) => (
            <span key={t.id}>
              {t.name}: {t.is_courtesy && t.my_capacity > 0 ? `${t.my_remaining}/${t.my_capacity} cupo` : `${t.available} disp.`}
              {t.price_cents > 0 ? ` · ${money(t.price_cents)}` : ""}
            </span>
          ))}
        </div>

        {!event.can_sell && <p className="promoter-hint">{saleReasonLabel(event.sell_reason)}</p>}

        <div className="promoter-card-actions">
          {event.can_sell ? (
            <button
              type="button"
              className="promoter-btn promoter-btn--primary promoter-btn--sm"
              onClick={() => nav(`/promotor/evento/${event.id}`)}
            >
              <Icon name="plus" aria-hidden="true" />
              Vender
            </button>
          ) : (
            <TransitionLink to={`/promotor/evento/${event.id}`} className="promoter-btn promoter-btn--sm">
              Ver evento
            </TransitionLink>
          )}
          <TransitionLink to={`/promotor/ventas?event_id=${event.id}`} className="promoter-btn promoter-btn--sm">
            <Icon name="ticket" aria-hidden="true" />
            Mis ventas
          </TransitionLink>
          <TransitionLink to={`/promotor/evento/${event.id}#kit`} className="promoter-btn promoter-btn--sm">
            <Icon name="link" aria-hidden="true" />
            Kit
          </TransitionLink>
        </div>
      </div>
    </article>
  );
}

export default function PromoterEventsView() {
  const { user } = useAuth();
  const venueId = activeVenueId(user);
  const [events, setEvents] = useState(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");

  async function load() {
    if (!venueId) return;
    setError("");
    setEvents(null);
    try {
      setEvents(await fetchPromoterEvents(venueId));
    } catch (err) {
      setError(err.message || "No pudimos cargar tus eventos.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (events || []).filter((e) => {
      if (needle && !`${e.name} ${e.venue_name} ${e.location || ""}`.toLowerCase().includes(needle)) return false;
      if (filter === "selling") return e.can_sell;
      if (filter === "upcoming") {
        const starts = e.starts_at ? new Date(e.starts_at).getTime() : 0;
        return (e.status === "published" || e.status === "draft") && starts > Date.now();
      }
      if (filter === "closed") return e.status === "ended" || e.status === "cancelled";
      return true;
    });
  }, [events, q, filter]);

  if (events === null && !error) return <PromoterSkeleton rows={3} />;

  return (
    <div className="promoter-page">
      <div className="promoter-head">
        <div>
          <span className="promoter-toplabel"><Icon name="sparkle" className="h-3 w-3" aria-hidden="true" />Tu espacio</span>
          <h1>Mis eventos</h1>
          <p>
            Todo lo que puedes vender esta noche, con tu cupo real. Abre un evento
            para emitir boletas, compartir tu link y revisar tus ventas.
          </p>
        </div>
        <button type="button" className="promoter-btn" onClick={load}>
          <Icon name="undo" aria-hidden="true" />
          Actualizar
        </button>
      </div>

      {error && (
        <PromoterAlert tone="danger" action={<button type="button" onClick={load}>Reintentar</button>}>
          {error}
        </PromoterAlert>
      )}

      {events && events.length === 0 && (
        <PromoterEmpty
          icon="calendar"
          title="Todavía no tienes eventos asignados"
          action={<button type="button" className="promoter-btn" onClick={load}>Volver a consultar</button>}
        >
          Cuando la organización te asigne a una noche, aparecerá aquí con su cupo
          y la acción para vender.
        </PromoterEmpty>
      )}

      {events && events.length > 0 && (
        <>
          <div className="promoter-toolbar">
            <label className="promoter-search">
              <Icon name="search" aria-hidden="true" />
              <span className="sr-only">Buscar evento</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar por evento, lugar u organización"
              />
            </label>
            <div className="promoter-filter-row" role="group" aria-label="Filtrar eventos">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="promoter-chip"
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <PromoterEmpty icon="search" title="Ningún evento coincide">
              Prueba otro término o quita los filtros.
            </PromoterEmpty>
          ) : (
            <div className="promoter-event-grid">
              {visible.map((event) => <EventCard key={event.id} event={event} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
