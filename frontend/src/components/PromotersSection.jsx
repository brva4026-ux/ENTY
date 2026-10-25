/**
 * PromotersSection — el equipo de promotores del mes con cupo y avance.
 *
 * `BusinessOverview` ya tiene un ranking de promotores, pero mide BOLETAS
 * sueltas: sin el cupo asignado no se ve quién va cumpliendo. Aquí el cupo
 * viene de `promoter_allocations` y el avance se calcula contra él, que es la
 * pregunta del dueño: "¿quién va a llegar y quién necesita un empujón?".
 *
 * El dinero de la comisión es real solo si hay liquidaciones generadas; en el
 * MVP el promotor mueve cortesías, así que puede venir en 0 sin que sea un
 * error. La columna se muestra siempre para que la ausencia se lea, no se
 * esconda.
 *
 * Se lee como la tabla de comisiones de la maqueta (panel-cockpit.css): avatar,
 * cupo usado, boletas, comisión y una barra de avance con su etiqueta.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { money, labelMonth } from "../lib/format";
import CountUpNumber from "./CountUpNumber";
import EmptyState from "./EmptyState";

/** Iniciales para el avatar (2 letras, tolera un solo nombre). */
function initials(name) {
  const parts = (name || "?").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/* Avance contra el cupo, con la etiqueta a la derecha. Sin cupo no hay meta:
 *  una barra llena haría ver "cumplido" a quien nunca tuvo objetivo. */
function AdvanceBar({ pct, hasCapacity }) {
  if (!hasCapacity) {
    return (
      <span className="pc-pav-block is-none">
        <span className="pc-pav-pct">sin cupo</span>
      </span>
    );
  }
  return (
    <span className="pc-pav-block">
      <span
        className="pc-pbar"
        role="img"
        aria-label={`${Math.round(pct)}% del cupo colocado`}
      >
        <i
          className={pct >= 100 ? "is-full" : pct >= 80 ? "is-warn" : undefined}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
      <span className="pc-pav-pct">{Math.round(pct)}%</span>
    </span>
  );
}

export default function PromotersSection({ venueId, month }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const qs = month ? `?month=${month}` : "";
    apiFetch(`/venues/${venueId}/promoters${qs}`)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError("");
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [venueId, month]);

  if (error) {
    return (
      <div className="rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
        {error}
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <div className="skeleton card h-20" />
        <div className="skeleton card h-64" />
      </div>
    );
  }

  const promoters = data?.promoters ?? [];
  const totalCapacity = data?.capacity_total ?? 0;
  const totalIssued = promoters.reduce((n, p) => n + p.issued, 0);
  const collectedPct =
    totalCapacity > 0 ? Math.round((totalIssued / totalCapacity) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="pc-sec">
        <h2>Promotores</h2>
        {data?.month && <span className="pc-when">{labelMonth(data.month)}</span>}
        {data?.commission_cents > 0 && (
          <span className="pc-aside">{money(data.commission_cents)} en comisiones</span>
        )}
      </div>

      {promoters.length === 0 ? (
        <EmptyState icon="users" title="Sin promotores este mes">
          Cuando asignes cupos a un promotor y coloque boletas, aquí verás su
          avance contra el cupo.
        </EmptyState>
      ) : (
        <>
          {/* El marcador del equipo: cuántos son, cuánto cupo llevan colocado
              y cuánto se llevan. Las tres cifras del dueño. */}
          <dl className="pc-tally">
            <div>
              <dt className="pc-t-label">Promotores</dt>
              <dd className="pc-t-value">
                <CountUpNumber value={promoters.length} />
              </dd>
              <span className="pc-t-note">activos este mes</span>
            </div>
            <div>
              <dt className="pc-t-label">Boletas colocadas</dt>
              <dd className="pc-t-value">
                <CountUpNumber value={totalIssued} />
                {totalCapacity > 0 && (
                  <small className="text-zinc-500"> / {totalCapacity}</small>
                )}
              </dd>
              <span className="pc-t-note">
                {totalCapacity > 0 ? `${collectedPct}% del cupo asignado` : "sin cupos asignados"}
              </span>
            </div>
            <div>
              <dt className="pc-t-label">Comisiones</dt>
              <dd className={`pc-t-value${data.commission_cents > 0 ? " is-good" : " is-mute"}`}>
                {money(data.commission_cents)}
              </dd>
              <span className="pc-t-note">
                {data.commission_cents > 0
                  ? "liquidaciones del mes"
                  : "sin liquidaciones generadas"}
              </span>
            </div>
          </dl>

          <div className="pc-ptable">
            <div className="pc-prow is-head">
              <span>Promotor</span>
              <span>Cupo</span>
              <span>Boletas</span>
              <span>Entraron</span>
              <span>Comisión</span>
              <span>Avance</span>
            </div>
            {promoters.map((p) => (
              <div className="pc-prow" key={p.promoter_id}>
                <span className="pc-pname">
                  <span className="pc-pav" aria-hidden="true">
                    {initials(p.name)}
                  </span>
                  <span className="min-w-0 truncate">{p.name}</span>
                  {p.has_courtesy && (
                    <span className="text-2xs font-normal text-zinc-500">cortesía</span>
                  )}
                </span>
                <span className="pc-pnum">{p.capacity > 0 ? p.capacity : "—"}</span>
                <span className="pc-pnum is-strong">{p.issued}</span>
                <span className="pc-pnum">{p.redeemed}</span>
                <span className="pc-pnum is-money">{money(p.commission_cents)}</span>
                <AdvanceBar pct={p.advance_pct} hasCapacity={p.capacity > 0} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
