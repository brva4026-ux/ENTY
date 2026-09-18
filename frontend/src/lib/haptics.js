/** Hápticas centralizadas: un solo lugar para el soporte, la intensidad y el
 *  respeto a prefers-reduced-motion. Las llamadas son no-op silenciosas en
 *  dispositivos sin vibración (escritorio). */

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function fire(pattern) {
  if (reducedMotion()) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* sin soporte: no-op */
  }
}

export const haptics = {
  /** Tap de navegación / toggle: confirmation sutil. */
  tick: () => fire(8),
  /** Acción completada (guardado, boleta emitida). */
  success: () => fire([15, 40, 25]),
  /** Rechazo / error: doble pulso grave. */
  warn: () => fire([60, 60, 60]),
};
