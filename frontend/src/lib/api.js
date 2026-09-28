// Cliente API. En dev, Vite hace proxy de /api -> backend:8000.
// En producción el frontend se sirve junto al backend o via gateway.
import { captureApiError } from "./sentry";

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
  return apiFetch(`/venues/${venueId}/events/${eventId}/tickets${q}`).then(
    (d) => d.items, // compat: los consumidores quieren el array
  );
}

/**
 * Listado paginado y filtrado de boletas. Devuelve { total, items }.
 * filters: { status, type_id, q, limit, offset } (todos opcionales).
 */
export function listTicketsPaged(venueId, eventId, filters = {}) {
  const qs = new URLSearchParams();
  if (filters.status) qs.set("status", filters.status);
  if (filters.type_id) qs.set("type_id", filters.type_id);
  if (filters.q) qs.set("q", filters.q);
  if (filters.limit) qs.set("limit", String(filters.limit));
  if (filters.offset) qs.set("offset", String(filters.offset));
  const suffix = qs.toString() ? `?${qs}` : "";
  return apiFetch(`/venues/${venueId}/events/${eventId}/tickets${suffix}`);
}

/**
 * Descarga autenticada del CSV del listado filtrado (fetch + Bearer + blob +
 * click). La URL se arma aqui: el token viaja en el header, nunca en la URL.
 */
export async function downloadTicketsCsv(venueId, eventId, filters = {}) {
  const qs = new URLSearchParams({ format: "csv" });
  if (filters.status) qs.set("status", filters.status);
  if (filters.type_id) qs.set("type_id", filters.type_id);
  if (filters.q) qs.set("q", filters.q);
  const token = localStorage.getItem("tf_token");
  const res = await fetch(
    `/api/venues/${venueId}/events/${eventId}/tickets?${qs}`,
    {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  );
  if (!res.ok) throw new Error("No se pudo exportar el CSV");
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `boletas-evento-${eventId}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/**
 * El invitado devuelve su boleta ("No puedo ir", mig 021). Endpoint PUBLICO:
 * el token crudo es la credencial. Devuelve la boleta a la plataforma, mata
 * el QR y libera el cupo del promotor. Irreversible.
 */
export function returnTicket(ticketId, rawToken) {
  return apiFetch("/tickets/return", {
    method: "POST",
    body: JSON.stringify({ ticket_id: ticketId, raw_token: rawToken }),
  });
}

// ---------------------------------------------------------------------------
// Lista de espera (mig 022, E2). Publico, sin cuentas: el token crudo del
// join es la credencial del fan y viaja en el cuerpo (nunca en la URL).
// ---------------------------------------------------------------------------

/** El fan entra a la fila de un evento agotado. */
export function waitlistJoin(eventId, name, phone) {
  return apiFetch(`/waitlist/${eventId}/join`, {
    method: "POST",
    body: JSON.stringify({ name, phone }),
  });
}

/** Estado del fan en la fila (posicion u oferta con countdown). */
export function waitlistStatus(token) {
  return apiFetch("/waitlist/status", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/** Reclama la oferta: devuelve una boleta NUEVA con su token de una sola vez. */
export function waitlistClaim(token) {
  return apiFetch("/waitlist/claim", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/** El fan se va de la fila por voluntad propia. */
export function waitlistLeave(token) {
  return apiFetch("/waitlist/leave", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function reissueTicket(venueId, eventId, ticketId, reason) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/tickets/${ticketId}/reissue`,
    {
      method: "POST",
      body: JSON.stringify({ reason: reason || null }),
    },
  );
}

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("tf_token");
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, { ...options, headers });
  } catch (networkErr) {
    // Sin respuesta (offline, DNS, abort): también es señal operativa.
    captureApiError(networkErr, {
      method: options.method ?? "GET",
      path,
      status: 0,
    });
    throw networkErr;
  }

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
    let msg = "Error en la petición";
    if (typeof detail === "string") {
      msg = detail;
    } else if (Array.isArray(detail)) {
      // 422 de FastAPI: lista de errores de validación, uno por campo. Mejor
      // mostrarlos que un "Error en la petición" que no dice nada.
      const msgs = detail.map((d) => d?.msg).filter(Boolean);
      if (msgs.length) msg = msgs.join(" · ");
    }
    const err = new Error(msg);
    err.status = res.status;
    // Los 5xx (y los fallos sin respuesta) son el signal que el dueño de la
    // app quiere antes que los usuarios; los 4xx son negocio normal.
    if (res.status >= 500) {
      captureApiError(err, {
        method: options.method ?? "GET",
        path,
        status: res.status,
      });
    }
    throw err;
  }
  return data;
}

/**
 * URL pública de la boleta (imagen con QR) que se envía al cliente.
 * No requiere sesión: el token crudo es el secreto de la boleta. Sirve tanto
 * en dev (Vite proxya /api) como en producción (mismo origen).
 */
export function publicTicketImageUrl(rawToken) {
  return `${window.location.origin}${BASE}/public/tickets/${encodeURIComponent(rawToken)}/image.jpg`;
}

/**
 * Página pública de la boleta: link reenviable con vista previa de WhatsApp
 * (og:image) y estado en vivo (una boleta anulada se ve como tal). Es el link
 * que se le envía al cliente; la imagen cruda queda para og:image/respaldo.
 */
export function publicTicketPageUrl(rawToken) {
  return `${window.location.origin}${BASE}/public/tickets/${encodeURIComponent(rawToken)}`;
}
