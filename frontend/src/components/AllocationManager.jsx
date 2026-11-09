import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useUI } from "../lib/ui";
import EmptyState from "./EmptyState";
import { QuotaMeter } from "./Brand";
import TransitionLink from "./TransitionLink";

export default function AllocationManager({
  venueId,
  eventId,
  allocations,
  types,
  users,
  onChange,
}) {
  const ui = useUI();
  const [promoterId, setPromoterId] = useState("");
  const [typeId, setTypeId] = useState("");
  const [capacity, setCapacity] = useState("5");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [draftCapacity, setDraftCapacity] = useState("5");
  const [busyId, setBusyId] = useState(null);
  const [saving, setSaving] = useState(false);
  // Distribución por lote (Ley de Tesler): en vez de P formularios idénticos,
  // el admin elige a quiénes y el total, y el sistema reparte. `mode` alterna
  // entre "uno" (una fila, el flujo de siempre) y "varios" (reparto igualitario).
  const [mode, setMode] = useState("uno");
  const [bulkPromoters, setBulkPromoters] = useState([]);
  const [bulkCapacity, setBulkCapacity] = useState("20");

  // SOLO promotores en el select: un admin no vende con su cupo, y mezclar
  // roles hacía el control confuso (tres "Admin/Promo" parecidos). Si un
  // día un admin también vende, se le asigna el rol promotor.
  const promoters = (users || []).filter((u) =>
    u.roles?.includes("promotor"),
  );

  const allocationUrl = (a) =>
    `/venues/${venueId}/events/${eventId}/allocations/${a.id}`;

  function replaceAllocation(updated) {
    onChange(
      (allocations || []).map((x) => (x.id === updated.id ? updated : x)),
    );
  }

  async function createAllocation(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const a = await apiFetch(
        `/venues/${venueId}/events/${eventId}/allocations`,
        {
          method: "POST",
          body: JSON.stringify({
            ticket_type_id: Number(typeId),
            promoter_id: Number(promoterId),
            capacity: Number(capacity),
          }),
        },
      );
      onChange([...(allocations || []).filter((x) => x.id !== a.id), a]);
      setErr("");
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setSaving(false);
    }
  }

  function toggleBulkPromoter(id) {
    setBulkPromoters((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  /** Reparto igualitario del total entre los promotores elegidos. */
  async function distributeBulk(e) {
    e.preventDefault();
    if (!typeId) {
      setErr("Elige el tipo de boleta a repartir.");
      return;
    }
    if (bulkPromoters.length === 0) {
      setErr("Elige al menos un promotor.");
      return;
    }
    setSaving(true);
    setErr("");
    try {
      const out = await apiFetch(
        `/venues/${venueId}/events/${eventId}/allocations/bulk`,
        {
          method: "POST",
          body: JSON.stringify({
            ticket_type_id: Number(typeId),
            promoter_ids: bulkPromoters,
            total_capacity: Number(bulkCapacity),
          }),
        },
      );
      // Refrescar la lista: el reparto puede haber tocado cupos que ya
      // existían (upsert de capacidad), así que se fusiona por id —los
      // devueltos mandan— en vez de reemplazar toda la lista.
      const byId = new Map((allocations || []).map((a) => [a.id, a]));
      for (const a of out.allocations) byId.set(a.id, a);
      onChange(
        [...byId.values()].sort((x, y) => x.promoter_id - y.promoter_id),
      );
      const extra = out.remainder
        ? ` (${out.remainder} extra a los primeros)`
        : "";
      setInfo(
        `${out.allocations.length} cupos de ${out.per_promoter}${extra}.`,
      );
      setBulkPromoters([]);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setSaving(false);
    }
  }

  function startEdit(a) {
    setEditingId(a.id);
    setErr("");
    setInfo("");
    setDraftCapacity(String(a.capacity));
  }

  async function saveEdit(a) {
    setBusyId(a.id);
    setErr("");
    try {
      const updated = await apiFetch(allocationUrl(a), {
        method: "PATCH",
        body: JSON.stringify({ capacity: Number(draftCapacity) }),
      });
      replaceAllocation(updated);
      setEditingId(null);
      setInfo("Cupo actualizado.");
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleAllocationActive(a) {
    setBusyId(a.id);
    setErr("");
    try {
      const updated = await apiFetch(allocationUrl(a), {
        method: "PATCH",
        body: JSON.stringify({ is_active: !a.is_active }),
      });
      replaceAllocation(updated);
      setInfo(updated.is_active ? "Cupo reactivado." : "Cupo archivado.");
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  async function removeAllocation(a) {
    const who = (users || []).find((x) => x.id === a.promoter_id);
    const ok = await ui.confirm(
      `¿Eliminar el cupo de ${who ? who.full_name : `#${a.promoter_id}`}?`,
      {
        message:
          "Si ya tiene boletas emitidas se archivará para no perder el historial.",
        danger: true,
        confirmLabel: "Eliminar",
      },
    );
    if (!ok) return;
    setBusyId(a.id);
    setErr("");
    try {
      const res = await apiFetch(allocationUrl(a), { method: "DELETE" });
      if (res.archived) {
        replaceAllocation({ ...a, is_active: false });
      } else {
        onChange((allocations || []).filter((x) => x.id !== a.id));
      }
      setInfo(res.detail);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="eyebrow">Distribución</p>
          <h3 className="display mt-0.5 text-base">Cupos de promotor</h3>
        </div>
        {/* El cuello de botella real: sin promotores creados no hay cupo que
          asignar. El enlace evita el ida-y-vuelta a Invitaciones. */}
        <TransitionLink
          to="?tab=invitaciones"
          className="text-xs font-semibold text-brand-300 transition hover:text-brand-200"
        >
          Invitar promotor →
        </TransitionLink>
      </div>
      <ul className="mb-4 space-y-2">
        {(allocations || []).map((a) => {
          const t = (types || []).find((x) => x.id === a.ticket_type_id);
          const u = (users || []).find((x) => x.id === a.promoter_id);
          return (
            <li
              key={a.id}
              className={`list-row px-3 py-2 ${
                a.is_active === false ? "opacity-60" : ""
              }`}
            >
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 font-semibold text-zinc-200">
                  {u ? u.full_name : `Promotor #${a.promoter_id}`}
                  {a.is_active === false && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-2xs font-bold uppercase text-amber-300 ring-1 ring-amber-500/30">
                      archivado
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <span className="tnum text-xs text-zinc-400">
                    {t ? t.name : `tipo ${a.ticket_type_id}`}
                  </span>
                  <button
                    onClick={() => startEdit(a)}
                    className="btn-mini"
                    data-variant="brand"
                  >
                    Editar
                  </button>
                  {a.is_active === false ? (
                    <button
                      onClick={() => toggleAllocationActive(a)}
                      disabled={busyId === a.id}
                      className="btn-mini"
                      data-variant="success"
                    >
                      Reactivar
                    </button>
                  ) : (
                    <button
                      onClick={() => removeAllocation(a)}
                      disabled={busyId === a.id}
                      className="btn-mini"
                      data-variant="danger"
                    >
                      Eliminar
                    </button>
                  )}
                </span>
              </div>
              {editingId === a.id ? (
                <div className="flex gap-2">
                  <input
                    aria-label="Capacidad asignada"
                    value={draftCapacity}
                    onChange={(e) => setDraftCapacity(e.target.value)}
                    className="field !py-1.5 text-xs"
                    placeholder="Capacidad"
                    inputMode="numeric"
                  />
                  <button
                    onClick={() => saveEdit(a)}
                    disabled={busyId === a.id}
                    className="btn-primary !py-1.5 text-xs"
                  >
                    {busyId === a.id ? "Guardando" : "Guardar"}
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="btn-ghost text-xs"
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <QuotaMeter
                  used={a.issued ?? 0}
                  total={a.capacity}
                  label="Usados"
                  compact
                />
              )}
            </li>
          );
        })}
        {(allocations || []).length === 0 && (
          <li className="col-span-full list-none">
            <EmptyState icon="users" title="Sin cupos asignados">
              Define abajo cuántas boletas puede vender cada promotor.
            </EmptyState>
          </li>
        )}
      </ul>
      {/* Orden mental del admin: QUIÉN vende → QUÉ vende → CUÁNTAS. Una sola
          fila, sin párrafos: los placeholders son la etiqueta. */}
      <div className="mb-2 flex gap-1" role="tablist" aria-label="Modo de asignación">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "uno"}
          onClick={() => setMode("uno")}
          className="btn-mini"
          data-variant={mode === "uno" ? "brand" : undefined}
        >
          Uno por uno
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "varios"}
          onClick={() => setMode("varios")}
          className="btn-mini"
          data-variant={mode === "varios" ? "brand" : undefined}
        >
          Repartir a varios
        </button>
      </div>
      {mode === "varios" ? (
        <form onSubmit={distributeBulk} className="space-y-2">
          {/* El tipo se elige primero: es el aforo que se reparte. */}
          <select
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className="field"
            aria-label="Tipo de boleta a repartir"
            required
          >
            <option value="">Tipo de boleta…</option>
            {(types || []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <fieldset className="rounded-lg border border-zinc-800 p-2">
            <legend className="px-1 text-2xs text-zinc-400">
              Promotores ({bulkPromoters.length} elegidos)
            </legend>
            {promoters.length === 0 ? (
              <p className="text-xs text-zinc-500">
                Todavía no hay promotores. Invítalos primero.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {promoters.map((u) => (
                  <label
                    key={u.id}
                    className="flex items-center gap-1.5 text-xs text-zinc-300"
                  >
                    <input
                      type="checkbox"
                      checked={bulkPromoters.includes(u.id)}
                      onChange={() => toggleBulkPromoter(u.id)}
                    />
                    {u.full_name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={bulkCapacity}
              onChange={(e) => setBulkCapacity(e.target.value)}
              className="field w-28"
              placeholder="Total"
              aria-label="Total de boletas a repartir"
              inputMode="numeric"
              required
            />
            <span className="text-2xs text-zinc-500">
              {bulkPromoters.length > 0 && Number(bulkCapacity) >= 0
                ? `≈ ${Math.floor(Number(bulkCapacity) / bulkPromoters.length)} por promotor`
                : "se reparte en partes iguales"}
            </span>
            <button
              className={`btn-primary ml-auto ${saving ? "is-busy" : ""}`}
              disabled={saving}
            >
              {saving && (
                <svg className="btn-spinner" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )}
              {saving ? "Repartiendo…" : "Repartir"}
            </button>
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
          {info && <p className="text-xs text-amber-300">{info}</p>}
        </form>
      ) : (
        <form
          onSubmit={createAllocation}
          className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_5.5rem_auto] sm:items-center"
        >
          <select
            value={promoterId}
            onChange={(e) => setPromoterId(e.target.value)}
            className="field"
            aria-label="Promotor"
            required
          >
            <option value="">Promotor…</option>
            {promoters.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name}
              </option>
            ))}
          </select>
          <select
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className="field"
            aria-label="Tipo de boleta"
            required
          >
            <option value="">Tipo de boleta…</option>
            {(types || []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <input
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            className="field"
            placeholder="Cupo"
            aria-label="Cupo (boletas que puede vender)"
            inputMode="numeric"
            required
          />
          <button
            className={`btn-primary ${saving ? "is-busy" : ""}`}
            disabled={saving}
          >
            {saving && (
              <svg className="btn-spinner" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
              </svg>
            )}
            {saving ? "Asignando…" : "Asignar"}
          </button>
          {err && <p className="col-span-full text-xs text-red-400">{err}</p>}
          {info && <p className="col-span-full text-xs text-amber-300">{info}</p>}
        </form>
      )}
    </div>
  );
}
