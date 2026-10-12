import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useUI } from "../lib/ui";
import EmptyState from "./EmptyState";

/** Atajos de tipos: un toque llena el formulario con lo tipico del rubro.
 * Cada uno explica para que sirve — sin adivinar nomenclaturas. */
const PRESETS = [
  {
    name: "General",
    price: "30000",
    courtesy: false,
    desc: "Entrada estandar de pie, la que más se vende.",
  },
  {
    name: "VIP",
    price: "80000",
    courtesy: false,
    desc: "Zona preferencial o beneficio extra (mesa, trago, baño VIP).",
  },
  {
    name: "Early bird",
    price: "20000",
    courtesy: false,
    desc: "Precio de preventa: premia a quien compra temprano.",
  },
  {
    name: "Cortesía",
    price: "0",
    courtesy: true,
    desc: "No se cobra: invitados, prensa, staff. Queda fuera del recaudo.",
  },
];

export default function TypeManager({ venueId, eventId, types, onChange }) {
  const ui = useUI();
  const [name, setName] = useState("General");
  // El usuario piensa en PESOS ("30.000"), la DB guarda centavos: convertir
  // en el borde. Antes pedía centavos y nadie entendía qué escribir.
  const [price, setPrice] = useState("30000");
  const [qty, setQty] = useState("50");
  const [isCourtesy, setIsCourtesy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({
    name: "",
    price: "",
    qty: "",
    isCourtesy: false,
  });
  const [busyId, setBusyId] = useState(null);
  const [saving, setSaving] = useState(false);

  const typeUrl = (t) => `/venues/${venueId}/events/${eventId}/types/${t.id}`;

  function replaceType(updated) {
    onChange((types || []).map((x) => (x.id === updated.id ? updated : x)));
  }

  async function createType(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const t = await apiFetch(`/venues/${venueId}/events/${eventId}/types`, {
        method: "POST",
        body: JSON.stringify({
          name,
          price_cents: Math.round(Number(price) * 100),
          quantity: Number(qty),
          is_courtesy: isCourtesy,
        }),
      });
      onChange([...(types || []), t]);
      setErr("");
      ui.success(`Tipo "${t.name}" agregado`);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setSaving(false);
    }
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
          price_cents: Math.round(Number(draft.price) * 100),
          quantity: Number(draft.qty),
          is_courtesy: draft.isCourtesy,
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
      <p className="eyebrow">Producto</p>
      <h3 className="display mb-3 mt-0.5 text-base">Tipos de boleta</h3>
      <ul className="mb-4 space-y-2">
        {(types || []).map((t) => (
          <li
            key={t.id}
            className={`list-row px-3 py-2 text-sm ${
              t.is_active === false ? "opacity-60" : ""
            }`}
          >
            {editingId === t.id ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="field col-span-full"
                  placeholder="Nombre"
                />
                <input
                  value={draft.price}
                  onChange={(e) =>
                    setDraft({ ...draft, price: e.target.value })
                  }
                  className="field"
                  placeholder="Precio en pesos (ej. 30000)"
                  inputMode="numeric"
                />
                <input
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
                  {t.is_active === false && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-2xs font-bold uppercase text-amber-300 ring-1 ring-amber-500/30">
                      archivado
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <span className="tnum text-zinc-400">
                    {t.price_cents > 0
                      ? `$${(t.price_cents / 100).toLocaleString("es-CO")}`
                      : "gratis"}{" "}
                    · cupo {t.quantity}
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
              Agrega el primero abajo y ya puedes vender.
            </EmptyState>
          </li>
        )}
      </ul>
      {/* Atajos: un toque llena el formulario — luego se ajusta el precio. */}
      <div className="mb-3">
        <p className="mb-1.5 text-xs font-medium text-zinc-400">Crear rápido:</p>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => {
              setName(p.name);
              setPrice(p.price);
              setIsCourtesy(p.courtesy);
            }}
            aria-pressed={name === p.name && isCourtesy === p.courtesy}
            data-tip={p.desc}
            className="opt-chip"
          >
            {p.name}
          </button>
          ))}
        </div>
        {PRESETS.filter((p) => p.name === name).map((p) => (
          <p key={p.name} className="mt-1.5 text-2xs text-zinc-500">
            {p.desc}
          </p>
        ))}
      </div>
      {/* Los placeholders son la etiqueta: cero párrafos explicativos. La
          ayuda de ejemplo vive DENTRO del input (prefijo), no debajo. */}
      <form
        onSubmit={createType}
        className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_5.5rem_auto] sm:items-start"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="field sm:col-start-1 sm:row-start-1"
          placeholder="Nombre (General, VIP…)"
          aria-label="Nombre del tipo"
          required
        />
        <label className="sm:col-start-1 sm:row-start-2">
          <span className="sr-only">Precio</span>
          <div className="relative">
            <span
              className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm ${
                isCourtesy ? "text-zinc-600" : "text-zinc-500"
              }`}
            >
              $
            </span>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="field !pl-7"
              placeholder="Precio"
              aria-label="Precio en pesos"
              inputMode="numeric"
              disabled={isCourtesy}
            />
          </div>
        </label>
        <input
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="field sm:col-start-2 sm:row-start-1"
          placeholder="Cupo"
          aria-label="Cupo (cuántas se pueden vender)"
          inputMode="numeric"
          required
        />
        <label className="flex items-center gap-2 text-sm text-zinc-300 sm:col-start-2 sm:row-start-2">
          <input
            type="checkbox"
            checked={isCourtesy}
            onChange={(e) => setIsCourtesy(e.target.checked)}
            className="accent-brand-500"
          />
          Cortesía
        </label>
        {err && <p className="col-span-full text-xs text-red-400">{err}</p>}
        {info && <p className="col-span-full text-xs text-amber-300">{info}</p>}
        <button
          className={`btn-primary sm:col-start-4 sm:row-start-1 sm:self-start ${
            saving ? "is-busy" : ""
          }`}
          disabled={saving}
        >
          {saving && (
            <svg className="btn-spinner" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
            </svg>
          )}
          {saving ? "Agregando…" : "Agregar"}
        </button>
      </form>
    </div>
  );
}
