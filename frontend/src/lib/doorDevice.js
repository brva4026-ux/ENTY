/**
 * Credencial del teléfono de Puerta (mig 064).
 *
 * El link de puerta se canjea una vez y el servidor devuelve un token de
 * DISPOSITIVO. Ese token es lo que identifica al puesto en cada escaneo; no es
 * el JWT de sesión. Si Administración releva o revoca el puesto, el token deja
 * de valer en el servidor aunque el navegador todavía lo tenga guardado.
 *
 * Vive en localStorage (no en la sesión) porque es de ESTE teléfono: cerrar y
 * abrir la app en la puerta no debería obligar a canjear el link otra vez.
 */
const PREFIX = "enty.door.device.";

export function getDoorDevice(eventId) {
  if (!eventId) return null;
  try {
    const raw = localStorage.getItem(PREFIX + String(eventId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data?.token ? data : null;
  } catch {
    return null;
  }
}

export function saveDoorDevice(eventId, device) {
  if (!eventId || !device?.token) return;
  try {
    localStorage.setItem(PREFIX + String(eventId), JSON.stringify(device));
  } catch {
    /* almacenamiento lleno o bloqueado: la puerta sigue con la sesión. */
  }
}

export function clearDoorDevice(eventId) {
  try {
    localStorage.removeItem(PREFIX + String(eventId));
  } catch {
    /* ignore */
  }
}

/** Headers de las operaciones de puerta para el evento. */
export function doorHeaders(eventId, extra = {}) {
  const device = getDoorDevice(eventId);
  return {
    ...(device?.token ? { "X-Door-Device": device.token } : {}),
    ...extra,
  };
}
