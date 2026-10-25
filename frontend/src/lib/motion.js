/**
 * Preferencia de movimiento con dos puertas.
 *
 * 1. El sistema operativo (`prefers-reduced-motion`): el default de la casa.
 *    Quien ya pidió menos movimiento en su teléfono no tiene que repetirlo.
 * 2. La app (este módulo): para quien quiere quietud en Enty aunque su
 *    sistema no lo pida. Es un ajuste real, no decoración.
 *
 * El SO SIEMPRE gana: si el dispositivo pide menos movimiento, elegir
 * "Completo" en la app no lo reactiva. Ignorar esa señal sería pisar una
 * preferencia de accesibilidad que el usuario ya expresó.
 *
 * Se aplica como `html[data-motion="reduce"]` (index.css): así el CSS apaga
 * la animación en toda la casa desde un solo atributo, sin tocar un JSX.
 */
const KEY = "tf_motion";

/** ¿El sistema pide menos movimiento ahora mismo? */
export function systemPrefersReduced() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** Preferencia guardada: "reduce" | "full" (default: "full" = seguir al SO). */
export function getMotionPreference() {
  try {
    return localStorage.getItem(KEY) === "reduce" ? "reduce" : "full";
  } catch {
    return "full";
  }
}

/** ¿Se debe reducir el movimiento? El SO tiene la última palabra. */
export function prefersReducedMotion() {
  return systemPrefersReduced() || getMotionPreference() === "reduce";
}

/** Aplica la preferencia al documento (atributo; sin atributo = movimiento normal). */
export function applyMotion(pref = getMotionPreference()) {
  const root = document.documentElement;
  if (pref === "reduce") {
    root.dataset.motion = "reduce";
  } else {
    delete root.dataset.motion;
  }
}

/** Guarda la preferencia y la aplica. */
export function setMotionPreference(pref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* sin storage: la preferencia dura la sesión */
  }
  applyMotion(pref);
}

/** Suscripción a cambios del sistema (para que el selector refleje la verdad). */
export function watchSystemMotion(cb) {
  const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  if (!mq) return () => {};
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
