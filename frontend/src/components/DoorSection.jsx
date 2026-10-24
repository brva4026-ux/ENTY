/**
 * DoorSection — la puerta del venue ENTERO, sin abrir una noche.
 *
 * El detalle por evento ya existe: `DoorPulse` (ritmo franja a franja) y
 * `EventWorkbench` (duplicados/rechazos) viven DENTRO de un evento abierto.
 * Eso obliga al admin a elegir una noche antes de saber qué está pasando.
 * Aquí responde la primera pregunta al llegar: ¿hay algo en vivo, cuánta
 * gente entró y la puerta está rechazando?
 *
 * Sin dinero a propósito: es operación, no caja. El aforo y las boletas son
 * de las noches EN VIVO (`status='live'`), no del mes.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { STATUS_META } from "./EventWorkbench";
import Icon from "./Icon";

/** "hace 12 s" desde un ISO. La puerta se lee en segundos, no en fechas. */
function sinceLabel(iso) {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return `hace ${h} h`;
}

function Stat({ label, value, sub, tone }) {
  // `tone` es una clase COMPLETA (no interpolada): Tailwind no genera clases
  // construidas en runtime, así que `text-${tone}` no existiría en el CSS.
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className={`tnum mt-1.5 text-2xl font-extrabold ${tone ?? "text-zinc-100"}`}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

export default function DoorSection({ venueId, onOpenEvent }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Relee cada 15 s: la puerta cambia mientras el admin mira. No es un reloj
  // por segundo (coste innecesario) pero sí lo bastante fresco para operar.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    apiFetch(`/venues/${venueId}/door`)
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
  }, [venueId, tick]);

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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton card h-24" />
          ))}
        </div>
        <div className="skeleton card h-40" />
      </div>
    );
  }

  const d = data ?? {};
  const insidePct =
    d.live_capacity > 0
      ? Math.round((d.live_redeemed / d.live_capacity) * 100)
      : 0;
  const soldPct =
    d.live_capacity > 0 ? Math.round((d.live_issued / d.live_capacity) * 100) : 0;
  const live = d.live_events > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2.5">
          <h2 className="display text-base">Puerta</h2>
          {live && (
            <span className="door-live-pill">
              <span className="door-live-dot" aria-hidden="true" />
              {d.live_events === 1 ? "1 noche en vivo" : `${d.live_events} noches en vivo`}
            </span>
          )}
        </div>
        {sinceLabel(d.last_scan_at) && (
          <span className="text-xs text-zinc-500">
            último escaneo {sinceLabel(d.last_scan_at)}
          </span>
        )}
      </div>

      {!live ? (
        <div className="card dp-empty p-6">
          <Icon name="door" className="h-4 w-4" aria-hidden="true" />
          <span>
            Ninguna noche está en puerta ahora. Cuando abras una, aquí verás
            cuánta gente entró y si la puerta está rechazando boletas.
          </span>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Dentro"
              value={d.live_redeemed}
              sub={`de ${d.live_issued} emitidas · ${insidePct}% del aforo`}
              tone="text-emerald-300"
            />
            <Stat
              label="Aforo de la noche"
              value={d.live_capacity}
              sub={`${soldPct}% vendido`}
            />
            <Stat
              label="Duplicados"
              value={d.duplicates}
              sub={
                d.duplicates > 0
                  ? "QR repetido: revisa reenvíos"
                  : "sin QRs repetidos"
              }
              tone={d.duplicates > 0 ? "text-amber-300" : undefined}
            />
            <Stat
              label="Rechazadas"
              value={d.rejected}
              sub={d.rejected > 0 ? "boletas que no cuadraron" : "todo cuadró"}
              tone={d.rejected > 0 ? "text-rose-400" : undefined}
            />
          </div>

          {/* El aforo de la noche: una barra ancha dice más que el número.
              Se marca lo VENDIDO y, encima, lo que ya ENTRÓ. */}
          <div className="card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="display text-sm">Aforo de la noche</p>
              <p className="tnum text-xs text-zinc-500">
                <span className="font-semibold text-zinc-200">{d.live_redeemed}</span> dentro ·{" "}
                <span className="font-semibold text-zinc-200">{d.live_issued}</span> vendidas ·{" "}
                {d.live_capacity} de aforo
              </p>
            </div>
            <div
              className="door-meter mt-3"
              role="img"
              aria-label={`${d.live_redeemed} personas dentro y ${d.live_issued} boletas vendidas de ${d.live_capacity} de aforo`}
            >
              <div className="door-meter-sold" style={{ width: `${soldPct}%` }} />
              <div className="door-meter-in" style={{ width: `${insidePct}%` }} />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-zinc-500">
              <span className="flex items-center gap-1.5">
                <span className="door-key door-key-in" aria-hidden="true" /> dentro
              </span>
              <span className="flex items-center gap-1.5">
                <span className="door-key door-key-sold" aria-hidden="true" /> vendidas sin entrar
              </span>
            </div>
          </div>
        </>
      )}

      {/* Todas las noches con puerta abierta o por abrir. Las en vivo primero:
          es lo que el admin necesita ver antes de scrollear. */}
      {d.events?.length > 0 && (
        <div>
          <p className="eyebrow mb-2">Noches con puerta</p>
          <div className="door-nights">
            {d.events.map((e) => {
              const meta = STATUS_META[e.status] ?? {};
              const pct = e.capacity > 0 ? Math.round((e.issued / e.capacity) * 100) : 0;
              const isLive = e.status === "live";
              return (
                <button
                  key={e.event_id}
                  type="button"
                  onClick={() => onOpenEvent?.(e.event_id)}
                  className={`door-night${isLive ? " is-live" : ""}`}
                  data-tip="Abrir la noche"
                >
                  <span className="door-night-top">
                    <span className="door-night-name">{e.name}</span>
                    <span className="evx-state">
                      <span className="evx-dot" data-status={e.status} aria-hidden="true" />
                      {meta.label ?? e.status}
                    </span>
                  </span>
                  <span className="door-night-meter">
                    <span
                      className={`door-night-fill${pct >= 100 ? " is-full" : pct >= 80 ? " is-warn" : ""}`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </span>
                  <span className="door-night-nums">
                    <span className="tnum">
                      {e.redeemed} dentro · {e.issued}/{e.capacity}
                    </span>
                    <span className="tnum text-zinc-500">{pct}%</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
