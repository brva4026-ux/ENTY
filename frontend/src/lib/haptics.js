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
  /**
   * Patrones de PUERTA: el resultado se siente en la mano aunque el portero
   * no mire la pantalla (en un roncino la vibración sola no alcanza, pero
   * confirma al instante mientras el sonido llega por el otro canal).
   * Cada familia tiene su firma, la misma gramática de los sonidos de puerta.
   */
  door: {
    /** ENTRA: pulso corto-fuerte + golpe largo — "paso autorizado". */
    granted: () => fire([30, 40, 90]),
    /** NO ENTRA (roja): triple golpe grave insistente. */
    denied: () => fire([80, 50, 80, 50, 80]),
    /** ÁMBAR (fila equivocada, otro evento, error): doble pulso neutro. */
    attention: () => fire([40, 70, 40]),
    /** AÚN NO ACTIVA: dos toques suaves — "espera, no es un rechazo". */
    wait: () => fire([20, 40, 20]),
    /** SIN RED: tres pulsos largos — "no puedes trabajar así". */
    offline: () => fire([100, 80, 100, 80, 100]),
  },
};
