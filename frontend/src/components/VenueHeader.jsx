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
import { Star5 } from "./Doodles";

/** "septiembre 2026" a partir de "2026-09". Local, sin dependencias. */
function labelMonth(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return "";
  const mes = new Date(y, m - 1, 1).toLocaleString("es-CO", { month: "long" });
  return `${mes} ${y}`;
}

export default function VenueHeader({ venueId, user, children = null }) {
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
          ((ov.revenue_cents - ov.prev_revenue_cents) / ov.prev_revenue_cents) *
            100,
        )
      : null;
  const up = (delta ?? 0) >= 0;

  return (
    <header className="venue-header card">
      {/* Fila superior: identidad (logo + nombre) a la izquierda, la cifra
        del negocio a la derecha. La portada completa sigue debajo: toolbar
        y franja de eventos viven DENTRO de este card (misma gramatica del
        dock Del negocio: un card = un contexto, secciones por hairline). */}
      <div className="vh-top">
        {/* Identidad: logo (o iniciales si no tiene) + nombre + eyebrow. El
          tile de identidad 56px es el ancla visual de la portada. */}
        <div className="vh-identidad">
          {venue?.logo_url ? (
            <img
              src={venue.logo_url}
              alt={`Logo de ${venue.name}`}
              className="vh-logo vh-logo-img"
            />
          ) : (
            <span className="vh-logo vh-logo-fallback" aria-hidden="true">
              {(venue?.name || "?").trim().charAt(0).toUpperCase()}
              {(venue?.name || "")
                .trim()
                .split(/\s+/)[1]
                ?.charAt(0)
                .toUpperCase() ?? ""}
            </span>
          )}
          {/* Lockup: el tile y el bloque de texto van juntos (gap corto) y
            el ritmo eyebrow→nombre lo fija la propia columna, no el leading
            del titular. El tamaño del nombre vive en .vh-nombre-titulo para
            que la escala sea una sola fuente de verdad. */}
          <div className="vh-nombre">
            <p className="eyebrow">Panel de la venue</p>
            <h1 className="display vh-nombre-titulo">
              {venue?.name ?? "Tu negocio"}
            </h1>
          </div>
        </div>

        {/* KPI headline: la cifra que un dueño mira primero, con tendencia.
            Capa POP: estrella doodle junto a la cifra (solo adorno). */}
        <div className="vh-kpi doodle-host">
          <Star5
            className="-right-1 top-4 h-3.5 w-3.5 rotate-12 text-[#ef6c8a]"
            aria-hidden="true"
          />
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
              <Skeleton className="h-12 w-44" />
            )}
            <p className="vh-kpi-meta">
              {/* Sello de goma (scrapbook): el mes queda "estampado" sobre la
                  cifra, como los sellos del cartel de referencia. */}
              {ov?.month && (
                <span className="rubber-stamp hidden text-[#ef6c8a] sm:inline-flex">
                  {labelMonth(ov.month).split(" ")[0]}
                </span>
              )}
              {delta !== null ? (
                <span
                  className={`vh-delta ${up ? "is-up" : "is-down"}`}
                  title="Comparado con el mes anterior"
                >
                  <Icon
                    name="arrowUp"
                    className={`h-3 w-3 ${up ? "" : "rotate-180"}`}
                  />
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
      </div>
      {/* Contenido embebido (toolbar de eventos + franja): separado de la
        fila de identidad por el hairline del sistema, como en Del negocio. */}
      {children && <div className="vh-embedded">{children}</div>}
    </header>
  );
}
