import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { createZone, deleteZone, listZones, updateZone } from "../lib/api";
import { plural } from "../lib/format";
import { useUI } from "../lib/ui";

const ZONE_STATUS = {
  open: { label: "Con cupo", tone: "ok" },
  near: { label: "Casi lleno", tone: "warn" },
  full: { label: "Lleno", tone: "danger" },
};

const EMPTY_FORM = { name: "", capacity: "" };

export default function ZonesPanel({
  venueId,
  eventId,
  types = [],
  onTypesChanged,
  live = false,
}) {
  const ui = useUI();
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);

  const zoneOptions = useMemo(
    () => zones.map((z) => ({ id: z.id, name: z.name })),
    [zones],
  );

  async function load() {
    setLoading(true);
    setError("");
    try {
      setZones(await listZones(venueId, eventId));
    } catch (err) {
      setError(err.message || "No pudimos leer las zonas.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, eventId]);

  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 20000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, venueId, eventId]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
  }

  function startEdit(zone) {
    setEditingId(zone.id);
    setForm({ name: zone.name, capacity: String(zone.capacity) });
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const name = form.name.trim();
    const capacity = Number(form.capacity);
    if (!name) {
      setError("Ponle un nombre a la zona.");
      return;
    }
    if (!Number.isInteger(capacity) || capacity <= 0) {
      setError("El aforo de la zona debe ser mayor que cero.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = { name, capacity };
      if (editingId) {
        await updateZone(venueId, eventId, editingId, payload);
        ui.toast("Zona actualizada.", "success");
      } else {
        await createZone(venueId, eventId, payload);
        ui.toast("Zona creada.", "success");
      }
      resetForm();
      await load();
    } catch (err) {
      setError(err.message || "No pudimos guardar la zona.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(zone) {
    const ok = await ui.confirm(`¿Eliminar la zona “${zone.name}”?`, {
      body: "Solo se puede eliminar si no tiene localidades asignadas.",
      confirmLabel: "Eliminar",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteZone(venueId, eventId, zone.id);
      ui.toast("Zona eliminada.", "success");
      if (editingId === zone.id) resetForm();
      await load();
    } catch (err) {
      ui.error(err.message || "No pudimos eliminar la zona.");
    }
  }

  async function assignType(tipo, zoneId) {
    try {
      const updated = await apiFetch(
        `/venues/${venueId}/events/${eventId}/types/${tipo.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ zone_id: zoneId ? Number(zoneId) : null }),
        },
      );
      onTypesChanged?.((types || []).map((t) => (t.id === updated.id ? updated : t)));
      await load();
    } catch (err) {
      ui.error(err.message || "No pudimos asignar la localidad.");
    }
  }

  return (
    <section className="admin-panel-card bs-zones">
      <div className="bs-box-office-head">
        <div>
          <h2>Aforo por zona</h2>
          <p>
            Pista, terraza y VIP tienen su propio tope. Enty cuenta personas
            adentro, no boletas emitidas, y avisa en Puerta cuando una zona se
            llena.
          </p>
        </div>
        <span className="bs-status" data-status={live ? "live" : "draft"}>
          <span className="bs-status-dot" aria-hidden="true" />
          {live ? "En vivo" : "Configuración"}
        </span>
      </div>

      {error && (
        <p className="admin-note" role="alert" data-tone="warn">
          {error}
        </p>
      )}

      {loading ? (
        <p className="admin-note">Leyendo zonas…</p>
      ) : zones.length === 0 ? (
        <p className="admin-note">
          Todavía no hay zonas. Crea la primera y asígnale sus localidades.
        </p>
      ) : (
        <div className="bs-zone-grid">
          {zones.map((zone) => {
            const meta = ZONE_STATUS[zone.status] || ZONE_STATUS.open;
            const pct = zone.capacity
              ? Math.min(100, Math.round((zone.inside / zone.capacity) * 100))
              : 0;
            return (
              <article
                key={zone.id}
                className="bs-zone-card"
                data-status={zone.status}
              >
                <header>
                  <div>
                    <h3>{zone.name}</h3>
                    <small>
                      {zone.inside} de {zone.capacity} adentro
                    </small>
                  </div>
                  <span className="bs-status" data-status={meta.tone}>
                    <span className="bs-status-dot" aria-hidden="true" />
                    {meta.label}
                  </span>
                </header>
                <div className="bs-zone-bar" aria-hidden="true">
                  <span style={{ width: `${pct}%` }} />
                </div>
                <p>
                  <strong>{zone.free_seats}</strong>{" "}
                  {plural(zone.free_seats, "lugar disponible", "lugares disponibles")}
                </p>
                <p className="bs-zone-types">
                  {zone.ticket_type_names.length
                    ? zone.ticket_type_names.join(" · ")
                    : "Sin localidades asignadas"}
                </p>
                <div className="bs-zone-actions">
                  <button
                    type="button"
                    className="btn-mini"
                    onClick={() => startEdit(zone)}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="btn-mini"
                    onClick={() => remove(zone)}
                  >
                    Eliminar
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <form className="bs-zone-form" onSubmit={submit}>
        <h3>{editingId ? "Editar zona" : "Nueva zona"}</h3>
        <div className="bs-zone-form-row">
          <label>
            <span>Nombre</span>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="VIP"
              maxLength={60}
              required
            />
          </label>
          <label>
            <span>Aforo</span>
            <input
              type="number"
              min="1"
              inputMode="numeric"
              value={form.capacity}
              onChange={(e) =>
                setForm((f) => ({ ...f, capacity: e.target.value }))
              }
              placeholder="120"
              required
            />
          </label>
          <div className="bs-zone-form-actions">
            {editingId && (
              <button type="button" className="bs-secondary" onClick={resetForm}>
                Cancelar
              </button>
            )}
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Guardando…" : editingId ? "Guardar zona" : "Crear zona"}
            </button>
          </div>
        </div>
      </form>

      <div className="bs-zone-assign">
        <h3>Localidades por zona</h3>
        <p>
          Cada localidad hereda el tope de su zona. Una zona puede agrupar
          varias localidades.
        </p>
        {(types || []).length === 0 ? (
          <p className="admin-note">Primero crea las localidades en Ventas.</p>
        ) : (
          <ul>
            {types.map((tipo) => (
              <li key={tipo.id}>
                <span>
                  <strong>{tipo.name}</strong>
                  <small>
                    {tipo.quantity} cupos · {tipo.issued ?? 0} emitidas
                  </small>
                </span>
                <select
                  value={tipo.zone_id ?? ""}
                  onChange={(e) => assignType(tipo, e.target.value)}
                  aria-label={`Zona de ${tipo.name}`}
                >
                  <option value="">Sin zona</option>
                  {zoneOptions.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
