/**
 * Cabecera de la VENUE: el primer vistazo del dashboard dice a qué negocio
 * estás administrando y cómo le va ESTE MES — sin entrar a Reportes.
 *
 * Datos: todo viene de lo que ya existe. Nombre/logo de `user.venues`
 * (los manda /auth/me); KPIs del endpoint /venues/{id}/overview (el mismo
 * que usa BusinessOverview, sin duplicar criterio contable).
 */
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { money } from "../lib/format";
import CountUpNumber from "./CountUpNumber";
import Icon from "./Icon";
import { Skeleton } from "./Skeleton";

/** "septiembre 2026" a partir de "2026-09". Local, sin dependencias. */
function labelMonth(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return "";
  const mes = new Date(y, m - 1, 1).toLocaleString("es-CO", { month: "long" });
  return `${mes} ${y}`;
}

export default function VenueHeader({ venueId, user, embedded = false, children = null }) {
  const [ov, setOv] = useState(null); // null = cargando (skeleton, no ceros)

  useEffect(() => {
    let alive = true;
    setOv(null);
    // Fire-and-forget: si falla, la cabecera muestra igualmente la identidad
    // (nombre/logo); solo el KPI queda en silencio. Nunca bloquea el panel.
    apiFetch(`/venues/${venueId}/overview`)
      .then((d) => alive && setOv(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [venueId]);

  const venue = (user?.venues || []).find((v) => v.id === venueId);
  const delta =
    ov && ov.prev_revenue_cents > 0
      ? Math.round(
          ((ov.revenue_cents - ov.prev_revenue_cents) / ov.prev_revenue_cents) * 100,
        )
      : null;
  const up = (delta ?? 0) >= 0;

  return (
    <header className={`venue-header card${embedded ? " is-embedded" : ""}`}>
      {/* Identidad: logo (o iniciales si no tiene) + nombre + etiqueta mes */}
      <div className="vh-identidad">
        {venue?.logo_url ? (
          <img
            src={venue.logo_url}
            alt={`Logo de ${venue.name}`}
            className="vh-logo"
          />
        ) : (
          <span className="vh-logo vh-logo-fallback" aria-hidden="true">
            {(venue?.name || "?").trim().charAt(0).toUpperCase()}
            {(venue?.name || "").trim().split(/\s+/)[1]?.charAt(0).toUpperCase() ?? ""}
          </span>
        )}
        <div className="min-w-0">
          <p className="eyebrow">Panel de la venue</p>
          <h1 className="display truncate text-lg leading-tight sm:text-xl">
            {venue?.name ?? "Tu negocio"}
          </h1>
        </div>
      </div>

      {/* KPI headline: la cifra que un dueño mira primero, con tendencia */}
      <div className="vh-kpi">
        <div className="min-w-0">
          <p className="vh-kpi-label">
            Recaudado {ov?.month ? `· ${labelMonth(ov.month)}` : ""}
          </p>
          {ov ? (
            <p className="vh-kpi-amount tnum">
              <CountUpNumber
                value={ov.revenue_cents / 100}
                format={(v) => money(v * 100)}
              />
            </p>
          ) : (
            <Skeleton className="h-9 w-40" />
          )}
          <p className="vh-kpi-meta">
            {delta !== null ? (
              <span
                className={`vh-delta ${up ? "is-up" : "is-down"}`}
                title="Comparado con el mes anterior"
              >
                <Icon name="arrowUp" className={`h-3 w-3 ${up ? "" : "rotate-180"}`} />
                {Math.abs(delta)}%
              </span>
            ) : (
              <span>—</span>
            )}
            <span>
              {ov
                ? `${ov.events_count} evento${ov.events_count === 1 ? "" : "s"} · ${ov.tickets_issued} boletas`
                : "cargando…"}
            </span>
          </p>
        </div>
      </div>
      {/* Contenido embebido (la toolbar de eventos: búsqueda + filtros +
        densidad). Solo tiene sentido en la portada del modo lista. */}
      {children && (
        <div className="vh-embedded">{children}</div>
      )}
    </header>
  );
}
