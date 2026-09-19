// Cliente de notificaciones in-app (mig 012, patrón unicall-blue).
// La escritura la hacen los triggers de la DB; acá solo se lee y se
// marca leído. Mismo transporte que el resto de la app (apiFetch).
import { apiFetch } from "./api";

/** Feed del usuario autenticado (más nuevo primero). `before` pagina por keyset. */
export function listNotifications(before) {
  const q = before ? `?before=${before}` : "";
  return apiFetch(`/notifications${q}`);
}

/** Conteo de no leídas: alimenta el badge de la campana. */
export function fetchUnreadCount() {
  return apiFetch("/notifications/unread-count");
}

/** Marca leídas: `ids` vacío = todas las del usuario. */
export function markNotificationsRead(ids = []) {
  return apiFetch("/notifications/read", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}
