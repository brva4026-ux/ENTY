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

function AdvanceBar({ pct, hasCapacity }) {
  if (!hasCapacity) {
    // Sin cupo no hay meta: una barra llena haría ver "cumplido" a quien
    // nunca tuvo objetivo asignado.
    return <span className="text-2xs text-zinc-500">sin cupo asignado</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <div
        className="padv-track"
        role="img"
        aria-label={`${pct}% del cupo colocado`}
      >
        <div
          className={`padv-fill${pct >= 100 ? " is-full" : pct >= 80 ? " is-warn" : ""}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className="tnum shrink-0 text-2xs font-bold text-zinc-400">
        {Math.round(pct)}%
      </span>
    </div>
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="display text-base">Promotores</h2>
        {data?.month && (
          <span className="text-xs capitalize text-zinc-500">
            {labelMonth(data.month)}
          </span>
        )}
      </div>

      {promoters.length === 0 ? (
        <EmptyState icon="users" title="Sin promotores este mes">
          Cuando asignes cupos a un promotor y coloque boletas, aquí verás su
          avance contra el cupo.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="card p-4">
              <p className="eyebrow">Promotores</p>
              <p className="tnum mt-1.5 text-2xl font-extrabold text-zinc-100">
                <CountUpNumber value={promoters.length} />
              </p>
            </div>
            <div className="card p-4">
              <p className="eyebrow">Boletas colocadas</p>
              <p className="tnum mt-1.5 text-2xl font-extrabold text-zinc-100">
                <CountUpNumber value={totalIssued} />
                {totalCapacity > 0 && (
                  <span className="text-sm font-semibold text-zinc-500">
                    {" "}
                    / {totalCapacity}
                  </span>
                )}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {totalCapacity > 0
                  ? `${Math.round((totalIssued / totalCapacity) * 100)}% del cupo asignado`
                  : "sin cupos asignados"}
              </p>
            </div>
            <div className="card p-4">
              <p className="eyebrow">Comisiones</p>
              <p className="tnum mt-1.5 text-2xl font-extrabold text-emerald-300">
                {money(data.commission_cents)}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {data.commission_cents > 0
                  ? "liquidaciones del mes"
                  : "sin liquidaciones generadas"}
              </p>
            </div>
          </div>

          <div className="ptable card">
            <div className="prow prow-hd">
              <span>Promotor</span>
              <span>Cupo</span>
              <span>Boletas</span>
              <span>Entraron</span>
              <span>Comisión</span>
              <span>Avance</span>
            </div>
            {promoters.map((p) => (
              <div className="prow" key={p.promoter_id}>
                <span className="prow-name">
                  <span className="prow-av" aria-hidden="true">
                    {initials(p.name)}
                  </span>
                  <span className="min-w-0 truncate">{p.name}</span>
                  {p.has_courtesy && (
                    <span className="text-2xs font-normal text-zinc-500">
                      cortesía
                    </span>
                  )}
                </span>
                <span className="tnum">
                  {p.capacity > 0 ? p.capacity : "—"}
                </span>
                <span className="tnum font-bold text-zinc-100">{p.issued}</span>
                <span className="tnum text-emerald-300">{p.redeemed}</span>
                <span className="tnum text-emerald-300">{money(p.commission_cents)}</span>
                <AdvanceBar pct={p.advance_pct} hasCapacity={p.capacity > 0} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
