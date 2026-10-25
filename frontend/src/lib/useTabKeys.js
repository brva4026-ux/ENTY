/**
 * Navegación por teclado del patrón ARIA tabs (roving tabindex + flechas).
 *
 * El patrón exige que dentro de un tablist solo la pestaña activa sea
 * tabulable (tabindex 0) y que las flechas muevan el foco entre pestañas.
 * Sin esto, un usuario de teclado tiene que tabular por cada pestaña para
 * salir del tablist.
 *
 * Uso:
 *   const { onKeyDown, tabIndexFor } = useTabKeys({ ids, activeId, onSelect });
 *   <button role="tab" tabIndex={tabIndexFor(id)} onKeyDown={onKeyDown}>
 */
import { useCallback } from "react";

export function useTabKeys({ ids, activeId, onSelect, idOf }) {
  const idFor = idOf ?? ((id) => id);

  const onKeyDown = useCallback(
    (e) => {
      const i = ids.indexOf(activeId);
      if (i === -1) return;
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown")
        next = ids[(i + 1) % ids.length];
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
        next = ids[(i - 1 + ids.length) % ids.length];
      else if (e.key === "Home") next = ids[0];
      else if (e.key === "End") next = ids[ids.length - 1];
      if (next == null) return;
      e.preventDefault();
      onSelect(next);
      // El foco sigue a la selección (activación automática, patrón ARIA).
      document.getElementById(idFor(next))?.focus();
    },
    [ids, activeId, onSelect, idFor]
  );

  const tabIndexFor = useCallback(
    (id) => (id === activeId ? 0 : -1),
    [activeId]
  );

  return { onKeyDown, tabIndexFor };
}

export default useTabKeys;
