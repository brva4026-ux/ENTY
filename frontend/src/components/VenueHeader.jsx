/**
 * Cabecera de la VENUE: el primer vistazo del dashboard dice a qué negocio
 * estás administrando y cómo le va ESTE MES — sin entrar a Reportes.
 *
 * Datos: todo viene de lo que ya existe. Nombre/logo/color de `user.venues`
 * (los manda /auth/me); KPIs, rankings y comisiones del endpoint
 * /venues/{id}/overview (el mismo que usa BusinessOverview, sin duplicar
 * criterio contable). El evento en vivo lo pasa el panel desde la lista que
 * ya cargó — no hay request extra para saber si la puerta está abierta.
 *
 * Jerarquía del dinero: el mes se lee de arriba abajo como una cuenta.
 * "Recaudado" es lo que entró; "comisiones" lo que se lleva el promotor;
 * "neto" lo que le queda al negocio. La cifra grande es la que un dueño
 * mira primero (el neto), el recaudado baja a línea de contexto.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { money, labelMonth, shiftMonth, currentYM } from "../lib/format";
import CountUpNumber from "./CountUpNumber";
import Icon from "./Icon";
import { Skeleton } from "./Skeleton";
import { Star5 } from "./Doodles";

/** Iniciales del negocio para el tile y la marca de agua: dos letras.
 *
 * Con una sola, "Bar Esquina" daba "B" y el tile parecía un avatar genérico;
 * el CSS ya reservaba `letter-spacing` para dos. Una palabra sola ("Fonda")
 * usa sus dos primeras letras, no una.
 */
function initialsOf(name) {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export default function VenueHeader({
  venueId,
  user,
  month,
  onMonth,
  liveEvent = null,
  children = null,
}) {
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

  // Color de marca del negocio. Ya venía en /auth/me y no se usaba: el panel
  // de cada venue puede llevar SU color. Se expone como variables CSS y el CSS
  // decide dónde aplicarlas; sin color, todo cae al violeta de V-Pass. El valor
  // llega validado como #RRGGBB desde el backend, pero se re-verifica aquí:
  // una venue vieja pudo guardarse antes de esa validación y este string
  // termina dentro de un `style`.
  const rawColor = venue?.primary_color || "";
  const brand = /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor.toLowerCase() : null;
  const initials = initialsOf(venue?.name);

  // El tile de iniciales se pinta con el color del negocio, así que el texto
  // no puede ser siempre blanco: sobre un amarillo claro no se lee. Luminancia
  // relativa (WCAG) para elegir tinta clara u oscura.
  const tileInk = (() => {
    if (!brand) return null;
    const [r, g, b] = [1, 3, 5].map((i) =>
      parseInt(brand.slice(i, i + 2), 16) / 255
    );
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.5 ? "#18181b" : "#ffffff";
  })();

  const tintStyle = brand
    ? {
        "--vh-brand": brand,
        "--vh-brand-wash": `${brand}17`, // 9% — lavado del card
        "--vh-brand-glow": `${brand}2e`, // 18% — banner
        "--vh-brand-line": `${brand}8f`, // 56% — viga del KPI
        "--vh-tile-ink": tileInk,
      }
    : undefined;

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
    <header
      className="venue-header card"
      style={tintStyle}
      data-brand={brand ? "1" : undefined}
      data-tour="portada"
    >
      {/* Banner de portada: da atmósfera y "cara" al negocio. Las iniciales
        gigantes en marca de agua son el recurso que evita que un venue sin
        flyer quede como una caja vacía — hay portada aunque no haya imagen.
        Puramente decorativo: el nombre real vive abajo, en el lockup. */}
      <div className="vh-banner" aria-hidden="true">
        <span className="vh-banner-initials">{initials}</span>
      </div>

      {/* Fila superior: identidad (logo + nombre) a la izquierda, la cifra
        del negocio a la derecha. La portada completa sigue debajo: toolbar
        y franja de eventos viven DENTRO de este card (misma gramática del
        dock Del negocio: un card = un contexto, secciones por hairline). */}
      <div className="vh-top">
        {/* Identidad: logo (o iniciales si no tiene) + nombre + eyebrow. El
          lockup entero lleva al perfil del negocio: la portada es también el
          camino para editar el nombre, el logo y el color. */}
        <Link
          to="/perfil?tab=negocio"
          className="vh-identidad"
          data-tip="Editar el negocio"
          aria-label={`Editar ${venue?.name ?? "el negocio"}`}
        >
          {venue?.logo_url ? (
            <img
              src={venue.logo_url}
              alt={`Logo de ${venue.name}`}
              className="vh-logo vh-logo-img"
            />
          ) : (
            <span className="vh-logo vh-logo-fallback" aria-hidden="true">
              {initials}
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
            {/* El estado operativo manda sobre cualquier adorno: si la puerta
              está abierta, esto es lo primero que el dueño necesita saber. */}
            {liveEvent && (
              <p className="vh-live">
                <span className="vh-live-dot" aria-hidden="true" />
                <span className="vh-live-txt">
                  En vivo · {liveEvent.name}
                </span>
              </p>
            )}
          </div>
        </Link>

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

      {/* El marcador del mes, en la voz del panel: cifras tabulares que se
          leen de un golpe. Sustituye al viejo desglose "Recaudado −
          Comisiones = Neto", que repetía el recaudado y el promedio justo
          debajo del KPI; aquí la resta vive en la nota del recaudado ("$N
          neto") y la comisión tiene su propia celda cuando existe. */}
      {ov && (
        <dl className="pc-tally vh-tally">
          <div>
            <dt className="pc-t-label">Recaudado</dt>
            <dd className="pc-t-value">
              <CountUpNumber value={revenue / 100} format={(v) => money(v * 100)} />
            </dd>
            <span className="pc-t-note">
              {hasCommissions ? `${money(net)} neto` : "sin comisiones este mes"}
            </span>
          </div>
          {hasCommissions && (
            <div>
              <dt className="pc-t-label">Comisiones</dt>
              <dd className="pc-t-value is-hot">{money(commissions)}</dd>
              <span className="pc-t-note">se lleva el promotor</span>
            </div>
          )}
          <div>
            <dt className="pc-t-label">Boletas</dt>
            <dd className="pc-t-value">
              <CountUpNumber value={ov.tickets_issued} />
            </dd>
            <span className="pc-t-note">
              {paid} paga{paid === 1 ? "" : "s"} ·{" "}
              {Math.max(0, ov.tickets_issued - paid)} cortesía
              {ov.tickets_issued - paid === 1 ? "" : "s"}
            </span>
          </div>
          <div>
            <dt className="pc-t-label">Ticket medio</dt>
            <dd className="pc-t-value">{avg > 0 ? money(avg) : "—"}</dd>
            <span className="pc-t-note">
              {avg > 0 ? "sobre boletas pagas" : "solo cortesías"}
            </span>
          </div>
          <div>
            <dt className="pc-t-label">Eventos</dt>
            <dd className="pc-t-value">
              <CountUpNumber value={ov.events_count} />
            </dd>
            <span className="pc-t-note">
              {liveEvent ? "1 en puerta ahora" : "ninguno en puerta"}
            </span>
          </div>
        </dl>
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
