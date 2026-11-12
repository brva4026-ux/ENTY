import { useEffect, useState } from "react";
import {
  addLineupItem,
  deleteLineupItem,
  listLineup,
  updateLineupItem,
} from "../lib/api";
import { useUI } from "../lib/ui";
import EmptyState from "./EmptyState";

/**
 * Lineup del evento (mig 043): los artistas de la noche, en orden de cartel.
 *
 * Antes la ficha pública mostraba la pestaña "Lineup" pero devolvía [] siempre
 * ("el modelo no tiene artistas"). Aquí el admin arma el cartel y el detalle
 * público lo lee tal cual.
 *
 * El orden (`sort_order`) es el del cartel: menor primero. Se edita con los
 * botones ↑/↓ en vez de pedir un número — el admin piensa "esto va antes", no
 * "sort_order 3".
 */
export default function LineupManager({ venueId, eventId }) {
  const ui = useUI();
  const [items, setItems] = useState(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ name: "", role: "" });

  useEffect(() => {
    let alive = true;
    listLineup(venueId, eventId)
      .then((rows) => alive && setItems(rows))
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [venueId, eventId]);

  async function add(e) {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setBusy(true);
    setErr("");
    try {
      // Los nuevos van al final del cartel: sort_order = último + 1.
      const nextOrder = items?.length
        ? Math.max(...items.map((i) => i.sort_order)) + 1
        : 0;
      const created = await addLineupItem(venueId, eventId, {
        name: name.trim(),
        role: role.trim() || null,
        sort_order: nextOrder,
      });
      setItems((cur) => [...(cur || []), created]);
      setName("");
      setRole("");
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(item) {
    setEditingId(item.id);
    setDraft({ name: item.name, role: item.role ?? "" });
  }

  async function saveEdit(item) {
    setBusyId(item.id);
    setErr("");
    try {
      const updated = await updateLineupItem(venueId, eventId, item.id, {
        name: draft.name.trim(),
        role: draft.role.trim() || null,
        sort_order: item.sort_order,
      });
      setItems((cur) => cur.map((i) => (i.id === item.id ? updated : i)));
      setEditingId(null);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(item) {
    const ok = await ui.confirm(`¿Quitar a "${item.name}" del lineup?`, {
      confirmLabel: "Quitar",
      danger: true,
    });
    if (!ok) return;
    setBusyId(item.id);
    setErr("");
    try {
      await deleteLineupItem(venueId, eventId, item.id);
      setItems((cur) => cur.filter((i) => i.id !== item.id));
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  /** Sube/baja un acto un lugar, intercambiando sort_order con su vecino. */
  async function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const a = items[index];
    const b = items[target];
    setBusyId(a.id);
    setErr("");
    try {
      // El orden es por sort_order: al intercambiar los valores, el cartel
      // queda como se ve. Se persisten los dos actos.
      const [ra, rb] = await Promise.all([
        updateLineupItem(venueId, eventId, a.id, {
          name: a.name,
          role: a.role ?? null,
          sort_order: b.sort_order,
        }),
        updateLineupItem(venueId, eventId, b.id, {
          name: b.name,
          role: b.role ?? null,
          sort_order: a.sort_order,
        }),
      ]);
      setItems((cur) =>
        cur
          .map((i) => (i.id === ra.id ? ra : i.id === rb.id ? rb : i))
          .sort((x, y) => x.sort_order - y.sort_order || x.id - y.id),
      );
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card p-5">
      <p className="eyebrow">Cartel</p>
      <h3 className="display mb-1 mt-0.5 text-base">Lineup</h3>
      <p className="mb-4 text-xs text-zinc-500">
        Los artistas de la noche, en orden. Aparecen en la ficha pública del
        evento, en la pestaña Lineup.
      </p>

      {items === null ? (
        <p className="text-sm text-zinc-500">Cargando lineup…</p>
      ) : items.length === 0 ? (
        <EmptyState icon="sparkle" title="Todavía no hay actos">
          Agrega el primer artista o DJ para armar el cartel.
        </EmptyState>
      ) : (
        <ul className="mb-4 space-y-2">
          {items.map((item, i) => (
            <li key={item.id} className="list-row px-3 py-2 text-sm">
              {editingId === item.id ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    aria-label="Nombre del acto"
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                    className="field"
                    placeholder="Nombre"
                  />
                  <input
                    aria-label="Rol del acto"
                    value={draft.role}
                    onChange={(e) =>
                      setDraft({ ...draft, role: e.target.value })
                    }
                    className="field"
                    placeholder="Rol (headliner, DJ, telonero…)"
                  />
                  <div className="col-span-full flex gap-2">
                    <button
                      onClick={() => saveEdit(item)}
                      disabled={busyId === item.id}
                      className="btn-primary flex-1 !py-1.5 text-xs"
                    >
                      {busyId === item.id ? "Guardando" : "Guardar"}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="btn-ghost text-xs"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-semibold text-zinc-200">
                    <span className="tnum text-2xs text-zinc-500">
                      {i + 1}
                    </span>
                    {item.name}
                    {item.role && (
                      <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-2xs font-bold uppercase text-brand-300 ring-1 ring-brand-500/30">
                        {item.role}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1">
                    <button
                      onClick={() => move(i, -1)}
                      disabled={busyId === item.id || i === 0}
                      className="btn-mini"
                      aria-label={`Subir a ${item.name}`}
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => move(i, 1)}
                      disabled={busyId === item.id || i === items.length - 1}
                      className="btn-mini"
                      aria-label={`Bajar a ${item.name}`}
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => startEdit(item)}
                      className="btn-mini"
                      data-variant="brand"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => remove(item)}
                      disabled={busyId === item.id}
                      className="btn-mini"
                      data-variant="danger"
                    >
                      Quitar
                    </button>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={add} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          aria-label="Nombre del nuevo acto"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="field"
          placeholder="Nombre del acto"
          maxLength={120}
        />
        <input
          aria-label="Rol del nuevo acto"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="field"
          placeholder="Rol (opcional)"
          maxLength={60}
        />
        <button
          type="submit"
          disabled={busy || name.trim().length < 2}
          className="btn-primary sm:col-span-full !py-1.5 text-xs"
        >
          {busy ? "Agregando…" : "Agregar al lineup"}
        </button>
      </form>

      {err && <p className="mt-3 text-xs text-red-400">{err}</p>}
    </div>
  );
}
