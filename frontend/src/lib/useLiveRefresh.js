import { useEffect, useRef, useState } from "react";

/**
 * Auto-refresh periódico mientras la pestaña está visible.
 *
 * - `refresh` debe ser estable (useCallback) o leído vía ref: no va en las
 *   deps a propósito, para que el intervalo no se recreate en cada tick.
 * - El intervalo solo corre cuando `enabled` es true (ej. evento en `live`).
 * - Pestaña oculta (document.hidden): no gasta requests; al volver a primer
 *   plano refresca de inmediato para que la vista no quede rancia.
 *
 * Devuelve la hora (Date) de la última actualización COMPLETADA, para que la
 * UI pueda mostrar "actualizado hace X". Es null hasta que termina el primer
 * refresh exitoso (o con error silencioso) del caller.
 */
export function useLiveRefresh(refresh, enabled, intervalMs = 15_000) {
  const [lastUpdated, setLastUpdated] = useState(null);
  // Ref para marcar la hora desde dentro del intervalo sin recrear el timer.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return;

    const mark = () => setLastUpdated(new Date());

    const tick = () => {
      if (document.hidden) return;
      // Se marca DESPUÉS del await: la hora refleja datos que ya llegaron.
      Promise.resolve(refreshRef.current?.()).finally(mark);
    };
    const onVisible = () => {
      if (!document.hidden) tick();
    };

    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // `refresh` va vía ref (patrón latest-ref): las deps solo incluyen lo que
    // debe reiniciar el intervalo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs]);

  return lastUpdated;
}

/** "hace 12 s" / "hace 3 min" a partir de una fecha. */
export function timeAgo(date, now = Date.now()) {
  if (!date) return "";
  const secs = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (secs < 60) return `hace ${secs} s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  return `hace ${hours} h`;
}
