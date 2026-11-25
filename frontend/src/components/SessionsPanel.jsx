import { useEffect, useMemo, useState } from "react";
import {
  archivePass,
  createPass,
  createSession,
  listPasses,
  listSessions,
} from "../lib/api";
import { money, plural } from "../lib/format";
import { useUI } from "../lib/ui";
import Icon from "./Icon";

function localInput(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function dateLabel(value, timezone) {
  try {
    return new Intl.DateTimeFormat("es-CO", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || undefined,
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

export default function SessionsPanel({ venueId, eventId, ev }) {
  const ui = useUI();
  const [sessions, setSessions] = useState([]);
  const [passes, setPasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionForm, setSessionForm] = useState({
    name: "",
    starts_at: localInput(new Date(Date.now() + 30 * 3600 * 1000)),
    capacity: 200,
  });
  const [passForm, setPassForm] = useState({
    name: "Pase completo",
    price: "",
    quantity: 100,
    session_ids: [],
  });

  const selectedSessions = useMemo(
    () => sessions.filter((s) => passForm.session_ids.includes(s.id)),
    [sessions, passForm.session_ids],
  );

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [nextSessions, nextPasses] = await Promise.all([
        listSessions(venueId, eventId),
        listPasses(venueId, eventId),
      ]);
      setSessions(nextSessions);
      setPasses(nextPasses);
      setPassForm((prev) => ({
        ...prev,
        session_ids: prev.session_ids.filter((id) =>
          nextSessions.some((s) => s.id === id),
        ),
      }));
    } catch (err) {
      setError(err.message || "No pudimos cargar las jornadas.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, eventId]);

  async function addSession(e) {
    e.preventDefault();
    if (busy) return;
    if (!sessionForm.name.trim()) {
      setError("Ponle nombre a la jornada.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createSession(venueId, eventId, {
        name: sessionForm.name.trim(),
        starts_at: new Date(sessionForm.starts_at).toISOString(),
        capacity: Number(sessionForm.capacity) || 1,
      });
      ui.toast("Jornada creada. Ya puedes incluirla en un pase.", "success");
      setSessionForm((prev) => ({ ...prev, name: "" }));
      await load();
    } catch (err) {
      setError(err.message || "No pudimos crear la jornada.");
    } finally {
      setBusy(false);
    }
  }

  async function addPass(e) {
    e.preventDefault();
    if (busy) return;
    if (!passForm.name.trim()) {
      setError("Ponle nombre al pase.");
      return;
    }
    if (!passForm.session_ids.length) {
      setError("Elige al menos una jornada.");
      return;
    }
    const priceCents = Math.round(Number(passForm.price || 0) * 100);
    if (priceCents < 0) {
      setError("El precio no puede ser negativo.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createPass(venueId, eventId, {
        name: passForm.name.trim(),
        price_cents: priceCents,
        quantity: Number(passForm.quantity) || 1,
        session_ids: passForm.session_ids,
      });
      ui.toast("Pase creado. Ya está a la venta en la ficha del evento.", "success");
      setPassForm((prev) => ({ ...prev, price: "", session_ids: [] }));
      await load();
    } catch (err) {
      setError(err.message || "No pudimos crear el pase.");
    } finally {
      setBusy(false);
    }
  }

  async function archive(item) {
    const ok = await ui.confirm(`¿Archivar el pase “${item.name}”?`, {
      body: "Deja de venderse. Las boletas ya emitidas siguen válidas.",
      confirmLabel: "Archivar",
      danger: true,
    });
    if (!ok) return;
    try {
      await archivePass(venueId, eventId, item.id);
      ui.toast("Pase archivado.", "success");
      await load();
    } catch (err) {
      ui.error(err.message || "No pudimos archivar el pase.");
    }
  }

  function toggleSession(id) {
    setPassForm((prev) => ({
      ...prev,
      session_ids: prev.session_ids.includes(id)
        ? prev.session_ids.filter((x) => x !== id)
        : [...prev.session_ids, id],
    }));
  }

  return (
    <div className="admin-panel-card bs-sessions">
      <div className="bs-box-office-head">
        <div>
          <h2>Jornadas y pases</h2>
          <p>
            Un evento puede tener varias fechas, zonas o accesos. Crea cada
            jornada y vende un pase que emite una boleta por jornada.
          </p>
        </div>
        <span className="bs-status" data-status="published">
          <span className="bs-status-dot" aria-hidden="true" />
          {sessions.length} {plural(sessions.length, "jornada", "jornadas")}
        </span>
      </div>

      {error && (
        <p className="admin-note" role="alert" data-tone="warn">
          {error}
        </p>
      )}

      <div className="bs-sessions-grid">
        <form className="bs-sessions-card" onSubmit={addSession}>
          <h3>Nueva jornada</h3>
          <p className="admin-note">
            Cada jornada tiene su propio aforo y su propia puerta.
          </p>
          <label className="bs-field">
            <span>Nombre</span>
            <input
              className="field"
              placeholder="Viernes 14 · Sala principal"
              value={sessionForm.name}
              onChange={(e) => setSessionForm((p) => ({ ...p, name: e.target.value }))}
            />
          </label>
          <div className="bs-form-row">
            <label className="bs-field">
              <span>Inicio</span>
              <input
                className="field"
                type="datetime-local"
                value={sessionForm.starts_at}
                onChange={(e) =>
                  setSessionForm((p) => ({ ...p, starts_at: e.target.value }))
                }
              />
            </label>
            <label className="bs-field">
              <span>Aforo</span>
              <input
                className="field"
                type="number"
                min="1"
                value={sessionForm.capacity}
                onChange={(e) =>
                  setSessionForm((p) => ({ ...p, capacity: e.target.value }))
                }
              />
            </label>
          </div>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Creando…" : "Crear jornada"}
          </button>
        </form>

        <form className="bs-sessions-card" onSubmit={addPass}>
          <h3>Nuevo pase</h3>
          <p className="admin-note">
            Se vende como una localidad más y emite una boleta por cada jornada
            elegida.
          </p>
          <label className="bs-field">
            <span>Nombre del pase</span>
            <input
              className="field"
              value={passForm.name}
              onChange={(e) => setPassForm((p) => ({ ...p, name: e.target.value }))}
            />
          </label>
          <div className="bs-form-row">
            <label className="bs-field">
              <span>Precio (COP)</span>
              <input
                className="field"
                type="number"
                min="0"
                step="100"
                placeholder="180000"
                value={passForm.price}
                onChange={(e) => setPassForm((p) => ({ ...p, price: e.target.value }))}
              />
            </label>
            <label className="bs-field">
              <span>Cantidad de pases</span>
              <input
                className="field"
                type="number"
                min="1"
                value={passForm.quantity}
                onChange={(e) =>
                  setPassForm((p) => ({ ...p, quantity: e.target.value }))
                }
              />
            </label>
          </div>
          <fieldset className="bs-session-picker">
            <legend>Jornadas incluidas</legend>
            {sessions.length === 0 ? (
              <p className="admin-note">Crea primero una jornada.</p>
            ) : (
              sessions.map((session) => (
                <label key={session.id} className="bs-session-check">
                  <input
                    type="checkbox"
                    checked={passForm.session_ids.includes(session.id)}
                    onChange={() => toggleSession(session.id)}
                  />
                  <span>
                    {session.name}
                    <small>{dateLabel(session.starts_at, ev.event_timezone)}</small>
                  </span>
                </label>
              ))
            )}
          </fieldset>
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !sessions.length || !selectedSessions.length}
          >
            {busy ? "Creando…" : "Crear pase"}
          </button>
        </form>
      </div>

      {loading ? (
        <p className="admin-note">Cargando jornadas…</p>
      ) : (
        <>
          <section className="bs-sessions-section">
            <h3>Jornadas</h3>
            {sessions.length === 0 ? (
              <p className="admin-note">Aún no hay jornadas.</p>
            ) : (
              <div className="bs-session-list">
                {sessions.map((session) => (
                  <div className="bs-session-row" key={session.id}>
                    <div>
                      <strong>{session.name}</strong>
                      <p>
                        {dateLabel(session.starts_at, ev.event_timezone)} ·{" "}
                        {session.capacity} de aforo · {session.issued} emitidas
                      </p>
                    </div>
                    <span className="bs-status" data-status={session.status === "live" ? "live" : "published"}>
                      <span className="bs-status-dot" aria-hidden="true" />
                      {session.status === "live" ? "En vivo" : "Publicada"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="bs-sessions-section">
            <h3>Pases a la venta</h3>
            {passes.length === 0 ? (
              <p className="admin-note">
                Aún no hay pases. Un pase es la forma de vender varias jornadas
                juntas.
              </p>
            ) : (
              <div className="bs-session-list">
                {passes.map((item) => (
                  <div className="bs-pass-row" key={item.id} data-inactive={!item.is_active}>
                    <div>
                      <strong>{item.name}</strong>
                      <p>
                        {money(item.price_cents)} · {item.quantity} pases ·{" "}
                        {item.sessions.length}{" "}
                        {plural(item.sessions.length, "jornada", "jornadas")}
                      </p>
                      <p className="bs-pass-sessions">
                        {item.sessions.map((s) => s.session_name).join(" · ")}
                      </p>
                    </div>
                    {item.is_active ? (
                      <button
                        type="button"
                        className="bs-secondary"
                        onClick={() => archive(item)}
                      >
                        <Icon name="trash" className="h-4 w-4" />
                        Archivar
                      </button>
                    ) : (
                      <span className="bs-status" data-status="cancelled">
                        Archivado
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
