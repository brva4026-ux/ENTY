/* ActionMenu — el menú "…" de acciones secundarias y destructivas.
 *
 * Ley de Hick: en una tarjeta o cabecera, cada botón visible al mismo nivel
 * es una decisión más y alarga la lectura. Las acciones que NO son el paso
 * principal (duplicar, cancelar, eliminar) viven aquí, a un toque de
 * distancia: siguen accesibles pero dejan de competir por la atención.
 *
 * Cierra al hacer click fuera y con Escape (mismo patrón que la campana de
 * notificaciones), y devuelve el foco al botón al cerrar con teclado.
 */
import { useEffect, useId, useRef, useState } from "react";
import Icon from "./Icon";

export default function ActionMenu({
  items,
  label = "Más acciones",
  align = "right",
  busy = false,
  className = "",
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const btnRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!items || items.length === 0) return null;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        data-tip={label}
        className="btn-ghost btn-icon !px-2 !py-1.5 text-zinc-400 disabled:opacity-40"
      >
        <Icon name="more" className="h-4 w-4" />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className={`menu-pop absolute z-30 mt-1 w-52 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 p-1 shadow-2xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {items.map((it) => (
            <button
              key={it.key ?? it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick?.();
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors disabled:opacity-40 ${
                it.danger
                  ? "text-red-400 hover:bg-red-500/10"
                  : "text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              {it.icon && (
                <Icon name={it.icon} className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate">{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
