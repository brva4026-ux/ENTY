import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./motion";

/**
 * Navegación con transición de vista (View Transitions API).
 *
 * El `useNavigate` declarativo de react-router (el que usa esta app con
 * `<BrowserRouter>`) NO acepta la opción `viewTransition` — eso es exclusivo
 * del data router. Por eso se envuelve el update a mano: React debe confirmar
 * el cambio de ruta de forma SÍNCRONA (`flushSync`) dentro del callback, o la
 * API captura el DOM viejo dos veces y el cruce no ocurre.
 *
 * Dos salidas sin transición, a propósito:
 *   1. Navegador sin soporte (Firefox estable aún no la trae): navega directo.
 *   2. Movimiento reducido (SO o ajuste de la app): la calma manda; el cruce
 *      se salta en vez de acortarse, porque una transición de 1ms igual
 *      parpadea el snapshot.
 */
export function withViewTransition(update) {
  const doc = typeof document !== "undefined" ? document : null;
  if (
    !doc ||
    typeof doc.startViewTransition !== "function" ||
    prefersReducedMotion()
  ) {
    update();
    return;
  }
  doc.startViewTransition(() => {
    flushSync(update);
  });
}
