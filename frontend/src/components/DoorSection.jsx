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
 *
 * La lectura es de instrumento (ver panel-cockpit.css): medidores con un
 * pulso REAL detrás (el `rhythm` que devuelve el backend), el aforo con
 * marcas de cuarto y la cola de escaneos. Nada de la gráfica es decorativo:
 * si no hay datos, no se dibuja.
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

/** "23:48:02" — la hora del escaneo: es la puerta de HOY. */
function clockLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/** Los veredictos que la puerta puede dar, con su etiqueta y su tono. */
const OUTCOME_META = {
  granted: { label: "Pasó", ok: true },
  granted_forced: { label: "Pasó · forzado", ok: true },
  already_redeemed: { label: "Ya usado", ok: false },
  not_found: { label: "No existe", ok: false },
  voided: { label: "Anulada", ok: false },
  wrong_event: { label: "Otra noche", ok: false },
};

function outcomeMeta(outcome) {
  return OUTCOME_META[outcome] ?? { label: outcome, ok: false };
}

/** Barras del pulso. Normaliza contra el pico de la serie: si la franja más
 *  floja se dibujara igual que la más fuerte, la gráfica no diría nada. */
function Spark({ series }) {
  if (!series?.length) return null;
  const peak = Math.max(...series.map((s) => s.n), 1);
  return (
    <div className="pc-spark" aria-hidden="true">
      {series.map((s, i) => (
        <i
          key={s.at ?? i}
          className={i === series.length - 1 ? "is-now" : undefined}
          style={{ height: `${Math.max(6, Math.round((s.n / peak) * 100))}%` }}
        />
      ))}
    </div>
  );
}

/** Un instrumento de puerta: cifra grande, contexto y pulso real detrás. */
function Instrument({ label, value, unit, sub, tone = "brand", series }) {
  return (
    <div className={`pc-dcard is-${tone}`}>
      <h3>{label}</h3>
      <p className="pc-big">
        {value}
        {unit && <small>{unit}</small>}
      </p>
      <p className="pc-sub">{sub}</p>
      <Spark series={series} />
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

  const rhythm = d.rhythm ?? [];
  const scans = d.recent_scans ?? [];
  // Ritmo de la última hora: la pendiente que dice si la noche arranca o se
  // apaga. Las franjas son de 30 min, así que son las dos últimas.
  const lastHour = rhythm.slice(-2).reduce((n, s) => n + s.n, 0);
  const peak = rhythm.reduce((n, s) => Math.max(n, s.n), 0);
  // Curva ACUMULADA de entradas: cómo se fue llenando la noche. Se deriva del
  // mismo `rhythm` real (no es un segundo request ni una serie inventada) y
  // evita que "Dentro" repita el mismo dibujo que "Ritmo".
  let acc = 0;
  const cumulative = rhythm.map((s) => ({ at: s.at, n: (acc += s.n) }));

  return (
    <div className="space-y-5">
      <div className="pc-sec">
        <h2>Puerta</h2>
        {live ? (
          <span className="door-live-pill">
            <span className="door-live-dot" aria-hidden="true" />
            {d.live_events === 1 ? "noche abierta" : `${d.live_events} noches abiertas`}
          </span>
        ) : (
          <span className="pc-when">cerrada</span>
        )}
        {sinceLabel(d.last_scan_at) && (
          <span className="pc-aside">último escaneo {sinceLabel(d.last_scan_at)}</span>
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
          <div className="pc-instruments">
            <Instrument
              label="Dentro"
              value={d.live_redeemed}
              sub={`de ${d.live_issued} vendidas · ${insidePct}% del aforo`}
              tone="in"
              series={cumulative}
            />
            <Instrument
              label="Ritmo de entrada"
              value={lastHour}
              unit="/h"
              sub={peak > 0 ? `pico ${peak * 2}/h esta noche` : "sin escaneos aún"}
              tone="brand"
              series={rhythm}
            />
            <Instrument
              label="QR repetidos"
              value={d.duplicates}
              sub={d.duplicates > 0 ? "alguien reenvió su boleta" : "ningún QR repetido"}
              tone={d.duplicates > 0 ? "warn" : "idle"}
            />
            <Instrument
              label="Rechazadas"
              value={d.rejected}
              sub={d.rejected > 0 ? "boletas que no cuadraron" : "todo cuadró"}
              tone={d.rejected > 0 ? "hot" : "idle"}
            />
          </div>

          {/* El aforo de la noche: medidor con marcas de cuarto. Se marca lo
              VENDIDO y, encima, lo que ya ENTRÓ. */}
          <div className="card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="display text-sm">Aforo de la noche</p>
              <p className="tnum text-xs text-zinc-500">
                <span className="font-semibold text-zinc-200">{d.live_redeemed}</span> dentro ·{" "}
                <span className="font-semibold text-zinc-200">{d.live_issued}</span> vendidas ·{" "}
                {d.live_capacity} de aforo
              </p>
            </div>
            <div className="pc-gauge mt-3">
              <div
                className="pc-gauge-track"
                role="img"
                aria-label={`${d.live_redeemed} personas dentro y ${d.live_issued} boletas vendidas de ${d.live_capacity} de aforo`}
              >
                <div
                  className="pc-gauge-fill"
                  style={{ width: `${Math.min(100, soldPct)}%` }}
                />
                <div
                  className="door-meter-in"
                  style={{ width: `${Math.min(100, insidePct)}%` }}
                />
                <div className="pc-gauge-marks">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <div className="pc-gauge-num">
                <b>
                  {d.live_redeemed}/{d.live_issued}
                </b>
                <span>
                  {insidePct}% dentro · {soldPct}% vendido
                </span>
              </div>
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

          {/* La puerta pasando: la cola de escaneos. Es el latido que hace que
              el panel se sienta vivo, y el único sitio donde el admin ve un
              rechazo en el momento en vez del reporte de mañana. */}
          {scans.length > 0 && (
            <div>
              <div className="pc-sec">
                <h2 className="pc-sec-sm">Últimos escaneos</h2>
                <span className="pc-aside">en vivo</span>
              </div>
              <div className="pc-queue">
                {scans.map((s, i) => {
                  const meta = outcomeMeta(s.outcome);
                  return (
                    <div className="pc-qrow" key={`${s.scanned_at}-${i}`}>
                      <span className="pc-q-index">{scans.length - i}</span>
                      <span className="pc-q-name">{s.customer_name ?? "—"}</span>
                      <span className="pc-q-type">{s.type_name ?? ""}</span>
                      <span className={`pc-q-verdict ${meta.ok ? "is-ok" : "is-no"}`}>
                        {meta.label}
                      </span>
                      <span className="pc-q-time">{clockLabel(s.scanned_at)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
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
