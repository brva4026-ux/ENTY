// Cliente de notificaciones in-app (mig 012, patrón unicall-blue).
// La escritura la hacen los triggers de la DB; acá solo se lee y se
// marca leído. Mismo transporte que el resto de la app (apiFetch).
import { apiFetch } from "./api";

/** Feed del usuario autenticado (más nuevo primero). `before` pagina por keyset.
 *  `venueId` limita el feed a la organización activa. */
export function listNotifications(before, venueId) {
  const params = new URLSearchParams();
  if (before) params.set("before", String(before));
  if (venueId) params.set("venue_id", String(venueId));
  const q = params.toString() ? `?${params}` : "";
  return apiFetch(`/notifications${q}`);
}

/** Conteo de no leídas: alimenta el badge de la campana. */
export function fetchUnreadCount(venueId) {
  const q = venueId ? `?venue_id=${venueId}` : "";
  return apiFetch(`/notifications/unread-count${q}`);
}

/** Marca leídas: `ids` vacío = todas las del usuario. */
export function markNotificationsRead(ids = []) {
  return apiFetch("/notifications/read", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}
