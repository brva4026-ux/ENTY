/**
 * Venue activa del usuario (multi-negocio).
 *
 * El usuario puede pertenecer a varias venues; la activa se elige en /perfil
 * y persiste en localStorage (`tf_venue`). Todos los paneles leen desde aquí:
 * un solo lugar para el criterio, sin copiar firstVenueId en cada página.
 *
 * Si la venue guardada ya no está entre las disponibles (le quitaron el
 * acceso, la venue se borró), se cae a la primera disponible — nunca a un
 * id fantasma que haría 403 todo el panel.
 */
const KEY = "tf_venue";

/** Ids de venue a los que el usuario tiene acceso (según sus roles). */
export function availableVenueIds(user) {
  return Object.keys(user?.roles || {}).map(Number);
}

/** Venue activa: la guardada si sigue disponible; si no, la primera. */
export function activeVenueId(user) {
  const available = availableVenueIds(user);
  if (available.length === 0) return null;
  const saved = Number(localStorage.getItem(KEY));
  return available.includes(saved) ? saved : available[0];
}

/** Cambia la venue activa (el selector de /perfil la llama). */
export function setActiveVenueId(id) {
  localStorage.setItem(KEY, String(id));
}
