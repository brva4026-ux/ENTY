/**
 * Venue activa del usuario (multi-negocio).
 *
 * El usuario puede pertenecer a varias venues; la activa se elige en /perfil.
 * Ley de Tesler (T7): la eleccion es de la PERSONA, no del navegador, asi que
 * la fuente de verdad es el servidor (`users.active_venue_id`, mig 040) y
 * viaja en `user.active_venue_id` desde /auth/me. Antes vivia solo en
 * localStorage (`tf_venue`): el mismo admin elegia su bar en la laptop y lo
 * perdia en el celular.
 *
 * localStorage se conserva como CACHE de arranque: en el primer paint (antes
 * de que /auth/me responda) y en la redireccion del login todavia no hay
 * `user` con la columna, y sin cache el panel abriria con el primer venue por
 * un instante. El servidor gana en cuanto llega; el cache solo evita el parpadeo.
 *
 * Si el venue guardado (servidor o cache) ya no esta entre las disponibles (le
 * quitaron el acceso, la venue se borro), se cae a la primera disponible —
 * nunca a un id fantasma que haria 403 todo el panel.
 */
const KEY = "tf_venue";

/** Ids de venue a los que el usuario tiene acceso (según sus roles). */
export function availableVenueIds(user) {
  return Object.keys(user?.roles || {}).map(Number);
}

/** Venue activa: la del servidor si sigue disponible; si no, la cache; si no, la primera. */
export function activeVenueId(user) {
  const available = availableVenueIds(user);
  if (available.length === 0) return null;
  const fromServer = Number(user?.active_venue_id);
  if (available.includes(fromServer)) return fromServer;
  const saved = Number(localStorage.getItem(KEY));
  return available.includes(saved) ? saved : available[0];
}

/** Cache local del cambio (para el arranque sin parpadeo; el servidor manda). */
export function setActiveVenueId(id) {
  localStorage.setItem(KEY, String(id));
}
