/**
 * Cabecera de la VENUE: el primer vistazo del dashboard dice a qué negocio
 * estás administrando y cómo le va ESTE MES — sin entrar a Reportes.
 *
 * Datos: todo viene de lo que ya existe. Nombre/logo de `user.venues`
 * (los manda /auth/me); KPIs, rankings y comisiones del endpoint
 * /venues/{id}/overview (el mismo que usa BusinessOverview, sin duplicar
 * criterio contable).
 *
 * Jerarquía del dinero: el mes se lee de arriba abajo como una cuenta.
 * "Recaudado" es lo que entró; "comisiones" lo que se lleva el promotor;
 * "neto" lo que le queda al negocio. La cifra grande es la que un dueño
 * mira primero (el neto), el recaudado baja a línea de contexto.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { money, labelMonth, shiftMonth, currentYM } from "../lib/format";
import CountUpNumber from "./CountUpNumber";
import Icon from "./Icon";
import { Skeleton } from "./Skeleton";
import { Star5 } from "./Doodles";

export default function VenueHeader({ venueId, user, month, onMonth, children = null }) {
  const [ov, setOv] = useState(null); // null = cargando (skeleton, no ceros)

  useEffect(() => {
    let alive = true;
    setOv(null);
    // Fire-and-forget: si falla, la cabecera muestra igualmente la identidad
    // (nombre/logo); solo el KPI queda en silencio. Nunca bloquea el panel.
    const qs = month ? `?month=${month}` : "";
    apiFetch(`/venues/${venueId}/overview${qs}`)
      .then((d) => alive && setOv(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [venueId, month]);

  const venue = (user?.venues || []).find((v) => v.id === venueId);

  // Mes mostrado: manda el que pide la URL; si no hay, el que dice el API
  // (zona del negocio, no la del navegador).
  const shownMonth = month || ov?.month || null;
  const nowYM = currentYM();
  const isCurrent = !month || month === nowYM;

  // La cuenta del mes. `commissions_cents` es null cuando no hay
  // liquidaciones: en el MVP el promotor solo mueve cortesías, así que "no
  // hay comisión calculable" no es lo mismo que "la comisión fue 0". Sin
  // comisión, el neto ES el recaudado y no se inventa una resta.
  const revenue = ov?.revenue_cents ?? 0;
  const commissions = ov?.commissions_cents ?? null;
  const hasCommissions = commissions !== null && commissions > 0;
  const net = hasCommissions ? revenue - commissions : revenue;
  const netLabel = hasCommissions ? "Neto del mes" : "Recaudado del mes";

  // Tendencia sobre el NETO (es la cifra que manda); si no hay comisiones,
  // coincide con la del recaudado.
  const prevNet = hasCommissions
    ? Math.max(0, (ov?.prev_revenue_cents ?? 0) - commissions)
    : ov?.prev_revenue_cents ?? 0;
  const delta =
    ov && ov.prev_revenue_cents > 0
      ? Math.round(((net - prevNet) / prevNet) * 100)
      : null;
  const up = (delta ?? 0) >= 0;

  const avg = ov?.avg_ticket_cents ?? 0;
  const paid = ov ? Math.max(0, ov.tickets_issued - ov.courtesy_tickets) : 0;

  return (
    <header className="venue-header card">
      {/* Fila superior: identidad (logo + nombre) a la izquierda, la cifra
        del negocio a la derecha. La portada completa sigue debajo: toolbar
        y franja de eventos viven DENTRO de este card (misma gramática del
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

        {/* KPI headline: la cuenta del mes. La cifra grande es el NETO (lo
            que le queda al negocio); el recaudado baja a la línea de
            contexto, junto a comisiones, promedio y boletas. */}
        <div className="vh-kpi doodle-host">
          <Star5
            className="-right-1 top-4 h-3.5 w-3.5 rotate-12 text-[#FF2D98]"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="vh-kpi-label">{netLabel}</p>
            {ov ? (
              <p className="vh-kpi-amount tnum">
                <CountUpNumber
                  value={net / 100}
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
                <span className="rubber-stamp hidden text-[#FF2D98] sm:inline-flex">
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

      {/* Desglose del mes: la cuenta que explica la cifra grande. Solo
          aparece cuando hay algo que explicar — con comisiones en 0 la línea
          del neto ya es el recaudado y repetirla sería ruido. */}
      {ov && (
        <div className="vh-cuenta">
          <div className="vh-cuenta-item">
            <span className="vh-cuenta-label">Recaudado</span>
            <span className="vh-cuenta-val tnum">{money(revenue)}</span>
          </div>
          {hasCommissions && (
            <>
              <span className="vh-cuenta-op" aria-hidden="true">
                −
              </span>
              <div className="vh-cuenta-item">
                <span className="vh-cuenta-label">Comisiones</span>
                <span className="vh-cuenta-val tnum is-out">
                  {money(commissions)}
                </span>
              </div>
              <span className="vh-cuenta-op" aria-hidden="true">
                =
              </span>
              <div className="vh-cuenta-item">
                <span className="vh-cuenta-label">Neto</span>
                <span className="vh-cuenta-val tnum is-net">{money(net)}</span>
              </div>
            </>
          )}
          <div className="vh-cuenta-item vh-cuenta-push">
            <span className="vh-cuenta-label">Promedio por boleta</span>
            <span className="vh-cuenta-val tnum">
              {avg > 0 ? money(avg) : "—"}
            </span>
            <span className="vh-cuenta-hint">
              {paid > 0
                ? `sobre ${paid} paga${paid === 1 ? "" : "s"}`
                : "solo cortesías este mes"}
            </span>
          </div>
        </div>
      )}

      {/* Navegación histórica: el mes del panel (y de Reportes) vive en la
          URL. Mismo idioma de flechas que Reportes; el botón "volver al mes
          actual" solo aparece cuando se salió de él. */}
      <div className="vh-mesnav">
        <div className="vh-mesnav-ctrl">
          <button
            type="button"
            onClick={() => onMonth?.(shiftMonth(shownMonth ?? nowYM, -1))}
            className="btn-mini btn-icon"
            data-variant="brand"
            aria-label="Mes anterior"
            disabled={!shownMonth}
          >
            <Icon name="back" className="h-3.5 w-3.5" />
          </button>
          <span className="vh-mesnav-label display capitalize">
            {shownMonth ? labelMonth(shownMonth) : "…"}
          </span>
          <button
            type="button"
            onClick={() => onMonth?.(shiftMonth(shownMonth ?? nowYM, 1))}
            className="btn-mini btn-icon"
            data-variant="brand"
            aria-label="Mes siguiente"
            disabled={!shownMonth || isCurrent}
          >
            <Icon name="back" className="h-3.5 w-3.5 rotate-180" />
          </button>
        </div>
        {!isCurrent && (
          <button
            type="button"
            onClick={() => onMonth?.(null)}
            className="vh-mesnav-hoy"
          >
            Volver al mes actual
          </button>
        )}
      </div>

      {/* Rankings del mes: datos que el overview YA devolvía y la portada
          tiraba a la basura (solo se veían dentro de Reportes). Con cero
          requests nuevos, la portada suma el "quién mueve la noche".
          La métrica es BOLETAS: en el MVP el promotor solo mueve cortesías. */}
      {ov && ov.top_promoters.length > 0 && (
        <div className="vh-rank">
          <div className="vh-rank-head">
            <p className="eyebrow">Quién mueve la noche</p>
            <span className="vh-rank-sub">
              por boletas colocadas con cupo propio
            </span>
          </div>
          <ol className="vh-rank-list">
            {ov.top_promoters.slice(0, 3).map((p, i) => {
              const max = Math.max(
                ...ov.top_promoters.map((x) => x.tickets),
                1,
              );
              const w = Math.max(4, Math.round((p.tickets / max) * 100));
              return (
                <li key={p.name} className="vh-rank-row">
                  <span
                    className={`vh-rank-pos tnum ${i === 0 ? "is-first" : ""}`}
                  >
                    {i + 1}
                  </span>
                  <span className="vh-rank-name">{p.name}</span>
                  <span className="vh-rank-count tnum">
                    {p.tickets}
                    {p.has_courtesy && (
                      <span className="vh-rank-courtesy"> cortesía</span>
                    )}
                  </span>
                  <span className="vh-rank-bar" aria-hidden="true">
                    <span
                      className="vh-rank-bar-fill"
                      style={{ width: `${w}%` }}
                    />
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {/* Contenido embebido (toolbar de eventos + franja): separado de la
        fila de identidad por el hairline del sistema, como en Del negocio. */}
      {children && <div className="vh-embedded">{children}</div>}
    </header>
  );
}
