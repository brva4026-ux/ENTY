// Cliente API. En dev, Vite hace proxy de /api -> backend:8000.
// En producción el frontend se sirve junto al backend o via gateway.
const BASE = "/api";

/**
 * Llamada a los endpoints publicos de boleta (invitado). No manda el token de
 * sesion ni espera JSON: estos endpoints devuelven datos o el JPEG de la boleta.
 * El token crudo viaja en el cuerpo para no quedar en logs ni en el historial.
 */
async function postBlob(path, rawToken) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_token: rawToken }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.detail ?? "";
    } catch {
      detail = "";
    }
    const err = new Error(detail || "No pudimos cargar la boleta");
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

export function fetchPublicTicket(rawToken) {
  return apiFetch("/tickets/preview", {
    method: "POST",
    body: JSON.stringify({ raw_token: rawToken }),
  });
}

export function fetchTicketImage(rawToken) {
  return postBlob("/tickets/image", rawToken);
}

export function listTickets(venueId, eventId, phone) {
  const q = phone ? `?phone=${encodeURIComponent(phone)}` : "";
  return apiFetch(`/venues/${venueId}/events/${eventId}/tickets${q}`);
}

export function reissueTicket(venueId, eventId, ticketId, reason) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/tickets/${ticketId}/reissue`, {
    method: "POST",
    body: JSON.stringify({ reason: reason || null }),
  });
}

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("tf_token");
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    // Token expirado/revocado en un endpoint autenticado: cerrar sesion
    // y mandar al login (el login mismo y el /auth/me ya manejan su caso).
    const hadToken = localStorage.getItem("tf_token");
    if (
      res.status === 401 &&
      hadToken &&
      path !== "/auth/login" &&
      path !== "/auth/me"
    ) {
      localStorage.removeItem("tf_token");
      window.location.assign("/login");
      const err = new Error("Tu sesión expiró. Ingresa de nuevo.");
      err.status = 401;
      throw err;
    }
    const detail = data?.detail;
    const msg = typeof detail === "string" ? detail : "Error en la petición";
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}