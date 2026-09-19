/**
 * Screen Wake Lock (Screen Wake Lock API estándar).
 *
 * En puerta el celular vive en la mano o en el bolsillo del chaleco con la
 * app abierta: que la pantalla se apague a los 30s con las manos ocupadas es
 * EL dolor del bouncer. El lock se pide al activar la cámara y se libera al
 * detenerla; si el SO lo revoca (por ejemplo al bloquear manualmente o al
 * cambiar de app), la reconquista es automática al volver a ser visible.
 *
 * Sin soporte (Firefox, iOS Safari viejo): no-ops silenciosos — la puerta
 * funciona igual, solo que la pantalla se apaga como siempre.
 */

let sentinel = null;

/** Pide el lock. Devuelve true si quedó activo. */
export async function requestWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return false;
    sentinel = await navigator.wakeLock.request("screen");
    // Si el SO lo libera (visibilidad, batería), poder reconquistar.
    sentinel.addEventListener("release", () => {
      sentinel = null;
    });
    return true;
  } catch {
    return false; // permiso denegado / modo ahorro: no es fatal
  }
}

/** Suelta el lock explícitamente (al detener el escáner). */
export async function releaseWakeLock() {
  try {
    if (sentinel) {
      await sentinel.release();
      sentinel = null;
    }
  } catch {
    /* ya estaba libre */
  }
}

/**
 * Reconquista automática: tras desbloquear el teléfono o volver de otra app,
 * visibilitychange lo vuelve a pedir. Se registra una sola vez.
 */
export function autoReacquireWakeLock() {
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !sentinel) {
      requestWakeLock();
    }
  });
}
