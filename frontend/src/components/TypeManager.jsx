import { useMemo, useState } from "react";
import { apiFetch, applyBulk, previewBulk } from "../lib/api";
import { useUI } from "../lib/ui";
import EmptyState from "./EmptyState";
import Icon from "./Icon";
import TicketTypeCreateDialog from "./TicketTypeCreateDialog";

export default function TypeManager({ venueId, eventId, types, report, onChange, capacity }) {
  const ui = useUI();
  const [createOpen, setCreateOpen] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({
    name: "",
    price: "",
    qty: "",
    isCourtesy: false,
    isVirtual: false,
  });
  const [busyId, setBusyId] = useState(null);
  const [selected, setSelected] = useState([]);
  const [bulkPreview, setBulkPreview] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const allSelected = useMemo(
    () => (types || []).length > 0 && selected.length === (types || []).length,
    [types, selected],
  );

  function toggleSelected(id) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function reviewBulk(action) {
    if (!selected.length) return;
    setBulkBusy(true);
    setErr("");
    try {
      const res = await previewBulk(venueId, eventId, {
        entity: "ticket_types",
        ids: selected,
        action,
      });
      setBulkPreview({ ...res, action });
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function confirmBulk() {
    if (!bulkPreview) return;
    setBulkBusy(true);
    setErr("");
    try {
      await applyBulk(venueId, eventId, {
        entity: "ticket_types",
        ids: selected,
        action: bulkPreview.action,
      });
      onChange(
        (types || []).map((t) =>
          selected.includes(t.id)
            ? { ...t, is_active: bulkPreview.action === "activate" }
            : t,
        ),
      );
      setInfo(
        bulkPreview.action === "activate"
          ? `${selected.length} tipos reactivados.`
          : `${selected.length} tipos pausados.`,
      );
      setSelected([]);
      setBulkPreview(null);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBulkBusy(false);
    }
  }

  const typeUrl = (t) => `/venues/${venueId}/events/${eventId}/types/${t.id}`;
  const byType = new Map((report?.by_type || []).map((t) => [t.ticket_type_id, t]));
  const priceFor = (value, courtesy) =>
    courtesy ? 0 : Math.round(Number(value) * 100);

  function replaceType(updated) {
    onChange((types || []).map((x) => (x.id === updated.id ? updated : x)));
  }

  function addType(type) {
    onChange([...(types || []), type]);
    setCreateOpen(false);
    ui.success(`Se creó ${type.name}`);
  }

  function startEdit(t) {
    setEditingId(t.id);
    setErr("");
    setInfo("");
    setDraft({
      name: t.name,
      // centavos -> pesos para editar como se piensa
      price: String(t.price_cents / 100),
      qty: String(t.quantity),
      isCourtesy: t.is_courtesy,
      isVirtual: !!t.is_virtual,
    });
  }

  async function saveEdit(t) {
    setBusyId(t.id);
    setErr("");
    try {
      const updated = await apiFetch(typeUrl(t), {
        method: "PATCH",
        body: JSON.stringify({
          name: draft.name.trim(),
          price_cents: priceFor(draft.price, draft.isCourtesy),
          quantity: Number(draft.qty),
          is_courtesy: draft.isCourtesy,
          is_virtual: draft.isVirtual,
        }),
      });
      replaceType(updated);
      setEditingId(null);
      setInfo("Tipo actualizado.");
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleTypeActive(t) {
    setBusyId(t.id);
    setErr("");
    try {
      const updated = await apiFetch(typeUrl(t), {
        method: "PATCH",
        body: JSON.stringify({ is_active: !t.is_active }),
      });
      replaceType(updated);
      setInfo(updated.is_active ? "Tipo reactivado." : "Tipo archivado.");
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  async function removeType(t) {
    const ok = await ui.confirm(`¿Eliminar el tipo "${t.name}"?`, {
      message:
        "Si ya tiene boletas emitidas se archivará para no perder el historial.",
      danger: true,
      confirmLabel: "Eliminar",
    });
    if (!ok) return;
    setBusyId(t.id);
    setErr("");
    try {
      const res = await apiFetch(typeUrl(t), { method: "DELETE" });
      if (res.archived) {
        replaceType({ ...t, is_active: false });
      } else {
        onChange((types || []).filter((x) => x.id !== t.id));
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
      <header className="ticket-type-list-head">
        <div>
          <h2 className="display">Tipos de boleta</h2>
          {(types || []).length > 0 && <p>Precio, cupo y disponibilidad por tipo.</p>}
        </div>
        <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
          <Icon name="plus" className="h-4 w-4" aria-hidden="true" />
          Nuevo tipo de boleta
        </button>
      </header>
      {err && (
        <p
          role="alert"
          className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400 ring-1 ring-red-500/30"
        >
          {err}
        </p>
      )}
      {info && <p role="status" className="mb-3 text-xs text-amber-300">{info}</p>}
      {(types || []).length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) =>
                setSelected(e.target.checked ? (types || []).map((t) => t.id) : [])
              }
            />
            Seleccionar todos
          </label>
          <span className="text-zinc-500">{selected.length} seleccionados</span>
          <button
            type="button"
            className="admin-inline-link"
            disabled={!selected.length || bulkBusy}
            onClick={() => reviewBulk("pause")}
          >
            Pausar
          </button>
          <button
            type="button"
            className="admin-inline-link"
            disabled={!selected.length || bulkBusy}
            onClick={() => reviewBulk("activate")}
          >
            Activar
          </button>
        </div>
      )}

      {bulkPreview && (
        <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <p className="font-semibold text-amber-300">
            Vas a {bulkPreview.action === "pause" ? "pausar" : "activar"}{" "}
            {bulkPreview.count} tipos de boleta
          </p>
          <ul className="mt-2 list-disc pl-4 text-zinc-300">
            {bulkPreview.affected.map((row) => (
              <li key={row.id}>
                {row.name} · {row.issued} boletas emitidas
              </li>
            ))}
          </ul>
          {bulkPreview.action === "pause" && bulkPreview.issued_tickets > 0 && (
            <p className="mt-2 text-amber-300">
              Las {bulkPreview.issued_tickets} boletas ya emitidas siguen siendo
              válidas para entrar. Solo se detiene la venta nueva.
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={confirmBulk}
              disabled={bulkBusy}
            >
              {bulkBusy ? "Aplicando…" : "Confirmar"}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setBulkPreview(null)}
              disabled={bulkBusy}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      <ul className="mb-4 space-y-2">
        {(types || []).map((t) => (
          <li
            key={t.id}
            className={`list-row px-3 py-2 text-sm ${
              t.is_active === false ? "opacity-60" : ""
            }`}
          >
            <label className="mr-2 inline-flex items-center">
              <input
                type="checkbox"
                aria-label={`Seleccionar ${t.name}`}
                checked={selected.includes(t.id)}
                onChange={() => toggleSelected(t.id)}
              />
            </label>
            {editingId === t.id ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  aria-label="Nombre del tipo de boleta"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="field col-span-full"
                  placeholder="Nombre"
                />
                <input
                  aria-label="Precio en pesos"
                  value={draft.price}
                  onChange={(e) =>
                    setDraft({ ...draft, price: e.target.value })
                  }
                  className="field"
                  placeholder="Precio en pesos (ej. 30000)"
                  inputMode="numeric"
                />
                <input
                  aria-label="Cantidad de boletas"
                  value={draft.qty}
                  onChange={(e) => setDraft({ ...draft, qty: e.target.value })}
                  className="field"
                  placeholder="Cantidad"
                  inputMode="numeric"
                />
                <label className="col-span-full flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={draft.isCourtesy}
                    onChange={(e) =>
                      setDraft({ ...draft, isCourtesy: e.target.checked })
                    }
                    className="accent-brand-500"
                  />
                  Cortesía (precio 0)
                </label>
                <label className="col-span-full flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={draft.isVirtual}
                    onChange={(e) =>
                      setDraft({ ...draft, isVirtual: e.target.checked })
                    }
                    className="accent-brand-500"
                  />
                  Virtual (transmisión, sin QR de puerta)
                </label>
                <div className="col-span-full flex gap-2">
                  <button
                    onClick={() => saveEdit(t)}
                    disabled={busyId === t.id}
                    className="btn-primary flex-1 !py-1.5 text-xs"
                  >
                    {busyId === t.id ? "Guardando" : "Guardar"}
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
                  {t.name}
                  {t.is_courtesy && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-2xs font-bold uppercase text-emerald-300 ring-1 ring-emerald-500/30">
                      cortesía
                    </span>
                  )}
                  {t.is_virtual && (
                    <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-2xs font-bold uppercase text-sky-300 ring-1 ring-sky-500/30">
                      virtual
                    </span>
                  )}
                  {t.is_active === false && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-2xs font-bold uppercase text-amber-300 ring-1 ring-amber-500/30">
                      archivado
                    </span>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="tnum text-zinc-400">
                    {t.price_cents > 0
                      ? `$${(t.price_cents / 100).toLocaleString("es-CO")}`
                      : "gratis"}{" "}
                    · {byType.has(t.id)
                      ? `${Math.max(0, t.quantity - (byType.get(t.id).issued ?? 0))} disponibles de ${t.quantity}`
                      : `cupo ${t.quantity}`}
                  </span>
                  <button
                    onClick={() => startEdit(t)}
                    className="btn-mini"
                    data-variant="brand"
                  >
                    Editar
                  </button>
                  {t.is_active === false ? (
                    <button
                      onClick={() => toggleTypeActive(t)}
                      disabled={busyId === t.id}
                      className="btn-mini"
                      data-variant="success"
                    >
                      Reactivar
                    </button>
                  ) : (
                    <button
                      onClick={() => removeType(t)}
                      disabled={busyId === t.id}
                      className="btn-mini"
                      data-variant="danger"
                    >
                      Eliminar
                    </button>
                  )}
                </span>
              </div>
            )}
          </li>
        ))}
        {(types || []).length === 0 && (
          <li className="col-span-full list-none">
            <EmptyState icon="ticket" title="Sin tipos de boleta aún">
              Crea el primer tipo para definir su precio y cupo.
            </EmptyState>
          </li>
        )}
      </ul>
      {createOpen && (
        <TicketTypeCreateDialog
          venueId={venueId}
          eventId={eventId}
          suggestedQuantity={(types || []).length === 0 ? capacity : null}
          onCreated={addType}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}
