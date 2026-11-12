import { useEffect, useState } from "react";
import {
  createCoupon,
  deleteCoupon,
  listCoupons,
  updateCoupon,
} from "../lib/api";
import { useUI } from "../lib/ui";
import { money } from "../lib/format";
import EmptyState from "./EmptyState";

/** Describe el descuento de un cupón en una línea legible. */
function describe(c) {
  return c.kind === "percent" ? `${c.value}% de descuento` : `${money(c.value)} menos`;
}

/**
 * Cupones del evento (mig 043): códigos de descuento para la venta online.
 *
 * Antes solo había cortesía (gratis) o precio fijo; un 2x1 o un "TEMPRANO20"
 * se resolvía por fuera. Aquí el admin crea el código y el checkout público lo
 * aplica: el fan paga el neto y el descuento queda registrado en caja.
 *
 * El código NO se edita (si te equivocaste, se desactiva y se crea otro): un
 * código ya dictado por WhatsApp que cambia de valor es una trampa.
 */
export default function CouponManager({ venueId, eventId }) {
  const ui = useUI();
  const [items, setItems] = useState(null);
  const [code, setCode] = useState("");
  const [kind, setKind] = useState("percent");
  // El admin piensa en % o en pesos; la DB guarda % o centavos. Se convierte
  // en el borde, nunca se le pide "value" crudo.
  const [value, setValue] = useState("20");
  const [maxUses, setMaxUses] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let alive = true;
    listCoupons(venueId, eventId)
      .then((rows) => alive && setItems(rows))
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [venueId, eventId]);

  function payloadValue() {
    if (kind === "percent") return Number(value);
    // Pesos -> centavos.
    return Math.round(Number(value) * 100);
  }

  async function create(e) {
    e.preventDefault();
    const v = payloadValue();
    if (!Number.isFinite(v) || v <= 0) {
      setErr("Pon un valor de descuento mayor que cero.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const created = await createCoupon(venueId, eventId, {
        code: code.trim(),
        kind,
        value: v,
        max_uses: maxUses ? Number(maxUses) : null,
      });
      setItems((cur) => [...(cur || []), created]);
      setCode("");
      setValue(kind === "percent" ? "20" : "5000");
      setMaxUses("");
      ui.success(`Cupón ${created.code} creado`);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(c) {
    setBusyId(c.id);
    setErr("");
    try {
      const updated = await updateCoupon(venueId, eventId, c.id, {
        is_active: !c.is_active,
      });
      setItems((cur) => cur.map((i) => (i.id === c.id ? updated : i)));
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(c) {
    const ok = await ui.confirm(`¿Eliminar el cupón ${c.code}?`, {
      message:
        c.used_count > 0
          ? "Ya se usó: se desactivará en vez de borrarse, para conservar el arqueo."
          : "Nadie lo ha usado todavía: se borra de verdad.",
      danger: true,
      confirmLabel: c.used_count > 0 ? "Desactivar" : "Eliminar",
    });
    if (!ok) return;
    setBusyId(c.id);
    setErr("");
    try {
      await deleteCoupon(venueId, eventId, c.id);
      // Un cupón usado queda desactivado (no se borra): se refleja igual.
      setItems((cur) =>
        c.used_count > 0
          ? cur.map((i) => (i.id === c.id ? { ...i, is_active: false } : i))
          : cur.filter((i) => i.id !== c.id),
      );
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card p-5">
      <p className="eyebrow">Descuentos</p>
      <h3 className="display mb-1 mt-0.5 text-base">Cupones</h3>
      <p className="mb-4 text-xs text-zinc-500">
        Códigos de descuento para la venta online. El fan los escribe al pagar;
        el precio baja y el descuento queda en el arqueo. No aplican a venta
        directa en puerta.
      </p>

      {items === null ? (
        <p className="text-sm text-zinc-500">Cargando cupones…</p>
      ) : items.length === 0 ? (
        <EmptyState icon="money" title="Todavía no hay cupones">
          Crea un código como TEMPRANO20 para premiar la compra anticipada.
        </EmptyState>
      ) : (
        <ul className="mb-4 space-y-2">
          {items.map((c) => {
            const usedUp = c.max_uses != null && c.used_count >= c.max_uses;
            return (
              <li
                key={c.id}
                className={`list-row px-3 py-2 text-sm ${
                  c.is_active === false ? "opacity-60" : ""
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2 font-semibold text-zinc-200">
                    <code className="rounded bg-zinc-800 px-2 py-0.5 text-xs tracking-wider">
                      {c.code}
                    </code>
                    <span className="text-zinc-400">{describe(c)}</span>
                    {c.is_active === false && (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-2xs font-bold uppercase text-amber-300 ring-1 ring-amber-500/30">
                        pausado
                      </span>
                    )}
                    {usedUp && (
                      <span className="rounded-full bg-zinc-500/15 px-2 py-0.5 text-2xs font-bold uppercase text-zinc-300 ring-1 ring-zinc-500/30">
                        agotado
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tnum text-xs text-zinc-500">
                      {c.used_count}
                      {c.max_uses != null ? `/${c.max_uses}` : ""} usos
                    </span>
                    <button
                      onClick={() => toggleActive(c)}
                      disabled={busyId === c.id}
                      className="btn-mini"
                    >
                      {c.is_active === false ? "Reactivar" : "Pausar"}
                    </button>
                    <button
                      onClick={() => remove(c)}
                      disabled={busyId === c.id}
                      className="btn-mini"
                      data-variant="danger"
                    >
                      {c.used_count > 0 ? "Desactivar" : "Eliminar"}
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={create} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input
          aria-label="Código del cupón"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          className="field tracking-wider"
          placeholder="TEMPRANO20"
          maxLength={40}
        />
        <select
          aria-label="Tipo de descuento"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setValue(e.target.value === "percent" ? "20" : "5000");
          }}
          className="field"
        >
          <option value="percent">Porcentaje (%)</option>
          <option value="fixed">Monto fijo ($)</option>
        </select>
        <input
          aria-label={kind === "percent" ? "Porcentaje" : "Monto en pesos"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="field"
          placeholder={kind === "percent" ? "20" : "5000"}
          inputMode="numeric"
        />
        <input
          aria-label="Máximo de usos"
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value)}
          className="field sm:col-span-2"
          placeholder="Máximo de usos (vacío = sin límite)"
          inputMode="numeric"
        />
        <button
          type="submit"
          disabled={busy || code.trim().length < 2}
          className="btn-primary !py-1.5 text-xs"
        >
          {busy ? "Creando…" : "Crear cupón"}
        </button>
      </form>

      {err && <p className="mt-3 text-xs text-red-400">{err}</p>}
    </div>
  );
}
