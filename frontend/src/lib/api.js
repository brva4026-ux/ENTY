// Cliente API. En dev, Vite hace proxy de /api -> backend:8000.
// En producción el frontend se sirve junto al backend o via gateway.
import { captureApiError } from "./sentry";
import { getToken, clearToken } from "./tokenStore";
import { cacheKey, dedupeGet } from "./apiCache";

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

/**
 * Catalogo publico de eventos para la app del fan (pantalla Inicio).
 * Sin sesion: mismo cliente que la boleta. `category`/`city` filtran del lado
 * del servidor; el backend ya recorta el resultado.
 */
export function fetchPublicEvents({ category, city, limit } = {}) {
  const qs = new URLSearchParams();
  if (category) qs.set("category", category);
  if (city) qs.set("city", city);
  if (limit) qs.set("limit", String(limit));
  const tail = qs.toString() ? `?${qs}` : "";
  return apiFetch(`/public/events${tail}`);
}

/**
 * Embudo de producto de una venue (solo admin): sesiones por paso y dinero
 * pagado. El backend lo calcula por sesiones, no por visitas.
 */
export function fetchVenueFunnel(venueId, days = 7) {
  return apiFetch(`/venues/${venueId}/funnel?days=${days}`);
}

/**
 * Detalle publico de un evento (pantalla de compra). Mismo caracter que el
 * catalogo: sin sesion. Un evento no publicado o inexistente responde 404.
 */
export function fetchPublicEventDetail(eventId, { preview = false } = {}) {
  const qs = preview ? "?preview=1" : "";
  return apiFetch(`/public/events/${encodeURIComponent(eventId)}${qs}`);
}

/**
 * Checkout publico del fan (sin cuenta). Crea el cobro en Wompi y devuelve la
 * URL a la que hay que mandar al comprador. El monto lo pone el SERVIDOR
 * (precio de la localidad); el cuerpo solo lleva localidad + contacto.
 */
export function startPublicCheckout(eventId, payload) {
  return apiFetch(`/public/events/${encodeURIComponent(eventId)}/checkout`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Sala de espera virtual (mig 055/056). El navegador es la identidad: guarda
 * el `session_token` que devuelve el join y lo manda en cada consulta.
 */
export function joinWaitingRoom(eventId, sessionToken) {
  return apiFetch(
    `/public/events/${encodeURIComponent(eventId)}/waiting-room/join`,
    {
      method: "POST",
      body: JSON.stringify({ session_token: sessionToken }),
    },
  );
}

export function fetchWaitingRoomStatus(eventId, sessionToken) {
  return apiFetch(
    `/public/events/${encodeURIComponent(eventId)}/waiting-room/status` +
      `?session_token=${encodeURIComponent(sessionToken)}`,
  );
}

/**
 * Estado de un checkout propio. La `reference` (128 bits) es la capability:
 * el fan la recibe al comprar y la conserva para el polling tras volver de
 * Wompi. No devuelve el token del QR (eso se reclama en /boletas).
 */
export function fetchPublicCheckoutStatus(reference) {
  return apiFetch(`/public/checkout/${encodeURIComponent(reference)}`);
}

/**
 * App del fan: "mis boletas" (magic link, sin cuenta).
 * El contacto NO es la credencial: solo pide que se envíe el enlace firmado a
 * ese correo. Devuelve un texto genérico (no revela si hay boletas) y si hay
 * correo configurado para enviarlo.
 */
export function fetchMyTickets(contact) {
  return apiFetch("/public/my-tickets", {
    method: "POST",
    body: JSON.stringify({ contact }),
  });
}

/**
 * Abre la lista con una credencial: `{ token }` (enlace firmado del correo) o
 * `{ raw_token }` (token de otra boleta propia). El contacto nunca basta.
 */
export function fetchFanTicketsWithAccess(credential) {
  return apiFetch("/public/my-tickets/access", {
    method: "POST",
    body: JSON.stringify(credential),
  });
}

/**
 * Regenera el enlace (QR) de UNA boleta propia, con la misma credencial que
 * abrió la lista. El token anterior muere: la DB rota el hash con
 * `reissue_ticket`. Devuelve el token crudo una sola vez.
 */
export function fetchMyTicketToken(ticketId, credential) {
  return apiFetch(`/public/my-tickets/${ticketId}/token`, {
    method: "POST",
    body: JSON.stringify(credential),
  });
}

/**
 * Listado paginado y filtrado de boletas. Devuelve { total, items }.
 * filters: { status, type_id, q, courtesy, limit, offset } (todos opcionales).
 */
export function listTicketsPaged(venueId, eventId, filters = {}) {
  const qs = new URLSearchParams();
  if (filters.status) qs.set("status", filters.status);
  if (filters.type_id) qs.set("type_id", filters.type_id);
  if (filters.q) qs.set("q", filters.q);
  if (filters.courtesy != null) qs.set("courtesy", String(filters.courtesy));
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
  if (filters.courtesy != null) qs.set("courtesy", String(filters.courtesy));
  const token = getToken();
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

export function fetchTicketHistory(venueId, eventId, ticketId) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/tickets/${ticketId}/history`,
  );
}

export function fulfillPaidPayment(venueId, eventId, paymentId) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/payments/${paymentId}/fulfill`,
    { method: "POST" },
  );
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

// ---------------------------------------------------------------------------
// Espacio de promotor (mig 063)
// ---------------------------------------------------------------------------
export function fetchPromoterEvents(venueId) {
  return apiFetch(`/venues/${venueId}/promoter/events`);
}

export function fetchPromoterEvent(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/promoter/events/${eventId}`);
}

export function fetchPromoterSales(venueId, filters = {}) {
  const qs = new URLSearchParams();
  for (const key of ["q", "event_id", "type_id", "channel", "status", "limit", "offset"]) {
    if (filters[key] != null && filters[key] !== "") qs.set(key, String(filters[key]));
  }
  if (filters.attention) qs.set("attention", "true");
  const tail = qs.toString() ? `?${qs}` : "";
  return apiFetch(`/venues/${venueId}/promoter/sales${tail}`);
}

export function fetchPromoterSale(venueId, ticketId) {
  return apiFetch(`/venues/${venueId}/promoter/sales/${ticketId}`);
}

export function editTicketContact(venueId, eventId, ticketId, payload) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/tickets/${ticketId}/contact`,
    { method: "PATCH", body: JSON.stringify(payload) },
  );
}

export function createPromoterIssue(venueId, ticketId, payload) {
  return apiFetch(`/venues/${venueId}/promoter/sales/${ticketId}/issue`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function resolvePromoterIssue(venueId, ticketId, issueId) {
  return apiFetch(
    `/venues/${venueId}/promoter/sales/${ticketId}/issue/${issueId}/resolve`,
    { method: "POST" },
  );
}

export function fetchPromoterCommissions(venueId) {
  return apiFetch(`/venues/${venueId}/promoter/commissions`);
}

export function fetchPromoterPayout(venueId, payoutId) {
  return apiFetch(`/venues/${venueId}/promoter/commissions/${payoutId}`);
}

export function fetchPromoterLink(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/promoter/events/${eventId}/link`);
}

export function recordPromoterLinkVisit(publicId) {
  return apiFetch(`/public/promoter-links/${encodeURIComponent(publicId)}/visit`, {
    method: "POST",
  });
}

export function fetchTicketByRequest(venueId, eventId, requestId) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/tickets/by-request/${encodeURIComponent(requestId)}`,
  );
}

/**
 * Reembolsa una boleta (mig 043): asigna el estado `refunded` que existía sin
 * dueño. Libera el cupo y deja la salida en caja. El monto es opcional (por
 * defecto, el precio pagado). Irreversible.
 */
export function refundTicket(venueId, eventId, ticketId, reason, amountCents) {
  const payload = { reason };
  if (amountCents != null) payload.amount_in_cents = amountCents;
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/tickets/${ticketId}/refund`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}

// ---------------------------------------------------------------------------
// Acreditaciones (mig 067): prensa, artistas, producción y patrocinadores.
// No son boletas ni entran en caja; la puerta las escanea igual.
// ---------------------------------------------------------------------------

export function listAccreditations(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/accreditations`);
}

export function createAccreditation(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/accreditations`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function revokeAccreditation(venueId, eventId, accreditationId) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/accreditations/${accreditationId}`,
    { method: "DELETE" },
  );
}

// ---------------------------------------------------------------------------
// Punto de equilibrio (mig 069): costos del evento y caja real.
// ---------------------------------------------------------------------------

export function getBreakEven(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/break-even`);
}

export function listCosts(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/costs`);
}

export function createCost(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/costs`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateCost(venueId, eventId, costId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/costs/${costId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteCost(venueId, eventId, costId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/costs/${costId}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Zonas del recinto (mig 070): pista, terraza, VIP y su aforo real.
// ---------------------------------------------------------------------------

export function listZones(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/zones`);
}

export function createZone(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/zones`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateZone(venueId, eventId, zoneId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/zones/${zoneId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteZone(venueId, eventId, zoneId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/zones/${zoneId}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Sesiones y pases (mig 068): un evento puede tener varias jornadas y un
// pase emite una boleta por cada una al confirmarse el pago.
// ---------------------------------------------------------------------------

export function listSessions(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/sessions`);
}

export function createSession(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/sessions`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function listPasses(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/passes`);
}

export function createPass(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/passes`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function archivePass(venueId, eventId, passId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/passes/${passId}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Lineup y cupones del evento (mig 043). Solo admin: son parte de armar la
// noche, no de operarla.
// ---------------------------------------------------------------------------

export function listLineup(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/lineup`);
}

export function addLineupItem(venueId, eventId, item) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/lineup`, {
    method: "POST",
    body: JSON.stringify(item),
  });
}

export function updateLineupItem(venueId, eventId, itemId, item) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/lineup/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify(item),
  });
}

export function deleteLineupItem(venueId, eventId, itemId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/lineup/${itemId}`, {
    method: "DELETE",
  });
}

export function listCoupons(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/coupons`);
}

export function createCoupon(venueId, eventId, coupon) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/coupons`, {
    method: "POST",
    body: JSON.stringify(coupon),
  });
}

export function updateCoupon(venueId, eventId, couponId, patch) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/coupons/${couponId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteCoupon(venueId, eventId, couponId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/coupons/${couponId}`, {
    method: "DELETE",
  });
}

/**
 * Cotiza un cupón para el fan (público): cuánto pagaría con ese código. NO lo
 * consume. `valid=false` significa que el código no aplica (no existe, expiró,
 * agotado o el evento no está a la venta).
 */
export function quotePublicCoupon(eventId, ticketTypeId, code) {
  const qs = new URLSearchParams({
    ticket_type_id: String(ticketTypeId),
    code,
  });
  return apiFetch(`/public/events/${eventId}/coupon?${qs}`);
}

// Micro-caché por ruta (segundos). Solo lecturas públicas y de cambio lento:
// el catálogo del fan (que la vitrina pide al montar y al que varias pantallas
// vuelven) y los textos legales (idénticos para todos). Todo lo demás queda en
// 0: los paneles con datos de negocio nunca sirven un dato viejo.
const TTL_MS = {
  "/public/events": 20_000,
  "/public/legal": 300_000,
};

function ttlFor(path) {
  for (const prefix of Object.keys(TTL_MS)) {
    if (path === prefix || path.startsWith(`${prefix}?`)) return TTL_MS[prefix];
  }
  return 0;
}

export function apiFetch(path, options = {}) {
  const method = (options.method ?? "GET").toUpperCase();
  // Solo GET: un POST/PATCH/DELETE muta estado y su respuesta no se comparte.
  if (method !== "GET") return apiRequest(path, options);
  const token = getToken();
  const key = cacheKey("GET", path, token);
  return dedupeGet(key, () => apiRequest(path, options), {
    ttlMs: ttlFor(path),
    bypass: options.fresh === true,
  });
}

async function apiRequest(path, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // `fresh` es una marca nuestra (bypass del micro-caché), no una opción de
  // fetch: se descarta antes de la llamada.
  const fetchOptions = { ...options };
  delete fetchOptions.fresh;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, { ...fetchOptions, headers });
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
    const authenticatedPath = path.startsWith("/venues/") || path.startsWith("/events/") ||
      (path.startsWith("/auth/") && !["/auth/login", "/auth/register", "/auth/me", "/auth/logout", "/auth/forgot-password", "/auth/reset-password", "/auth/invitations/accept"].includes(path));
    if (
      res.status === 401 &&
      authenticatedPath &&
      path !== "/auth/login" &&
      path !== "/auth/me"
    ) {
      clearToken();
      window.location.assign("/login");
      const err = new Error("Tu sesión expiró. Ingresa de nuevo.");
      err.status = 401;
      throw err;
    }
    const detail = data?.detail;
    let msg = "Error en la petición";
    let fields = {};
    if (typeof detail === "string") {
      msg = detail;
    } else if (Array.isArray(detail)) {
      // 422 de FastAPI: lista de errores de validación, uno por campo. Mejor
      // mostrarlos que un "Error en la petición" que no dice nada.
      const msgs = detail.map((d) => d?.msg).filter(Boolean);
      if (msgs.length) msg = msgs.join(" · ");
      for (const item of detail) {
        const key = Array.isArray(item?.loc)
          ? [...item.loc]
              .reverse()
              .find((part) => typeof part === "string" && part !== "body")
          : null;
        if (key && item?.msg) {
          fields[key] = String(item.msg).replace(/^Value error,\s*/i, "");
        }
      }
    } else if (res.status >= 500) {
      // Un 5xx del servidor o del proxy llega sin `detail` (FastAPI devuelve
      // "Internal Server Error" en texto plano, Vercel una página de error).
      // Decir "Error en la petición" dejaba al usuario sin saber si su clave
      // estaba mal o si el servicio estaba caído — y así se reportó como si
      // fuera un fallo de credenciales.
      msg = `El servicio falló (${res.status}). Intenta de nuevo en un momento.`;
    }
    const err = new Error(msg);
    err.status = res.status;
    err.detail = detail;
    if (Object.keys(fields).length) err.fields = fields;
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
 * Página pública de la boleta: link reenviable con vista previa de WhatsApp
 * (og:image) y estado en vivo (una boleta anulada se ve como tal). Es el link
 * que se le envía al cliente; la imagen cruda queda para og:image/respaldo.
 */
export function publicTicketPageUrl(rawToken) {
  return `${window.location.origin}${BASE}/public/tickets/${encodeURIComponent(rawToken)}`;
}

/**
 * Pide el enlace de recuperación de contraseña. Respuesta genérica del
 * backend (no revela si el correo existe): la pantalla de login la muestra
 * tal cual. Rate-limited del lado del servidor.
 */
export function forgotPassword(email) {
  return apiFetch("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

// ---------------------------------------------------------------------------
// Suite operativa y comercial (mig 071)
// ---------------------------------------------------------------------------
export function listTransport(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/transport`);
}
export function createTransport(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/transport`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function deleteTransport(venueId, eventId, id) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/transport/${id}`, {
    method: "DELETE",
  });
}
export function listMapPoints(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/map-points`);
}
export function createMapPoint(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/map-points`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function deleteMapPoint(venueId, eventId, id) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/map-points/${id}`, {
    method: "DELETE",
  });
}
export function publicEventExtras(eventId) {
  return apiFetch(`/public/events/${eventId}/extras`);
}
export function listShifts(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/shifts`);
}
export function updateShift(venueId, eventId, userId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/shifts/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}
export function listStaffCheckins(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/staff-checkins`);
}
export function staffCheckin(venueId, eventId, payload = {}) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/staff-checkin`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function staffCheckout(venueId, eventId, id) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/staff-checkins/${id}/checkout`, {
    method: "POST",
  });
}
export function listOpsOrders(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/ops-orders`);
}
export function createOpsOrder(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/ops-orders`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function ackOpsOrder(venueId, eventId, id) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/ops-orders/${id}/ack`, {
    method: "POST",
  });
}
export function resolveOpsOrder(venueId, eventId, id) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/ops-orders/${id}/resolve`, {
    method: "PATCH",
  });
}
export function listEquipment(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/equipment`);
}
export function createEquipment(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/equipment`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function updateEquipment(venueId, eventId, id, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/equipment/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}
export function listBookings(venueId) {
  return apiFetch(`/venues/${venueId}/bookings`);
}
export function createBooking(venueId, payload) {
  return apiFetch(`/venues/${venueId}/bookings`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function listMilestones(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/milestones`);
}
export function createMilestone(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/milestones`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function updateMilestone(venueId, eventId, id, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/milestones/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}
export function listDocuments(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/documents`);
}
export function createDocument(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/documents`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function listCourtesyRequests(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/courtesy-requests`);
}
export function createCourtesyRequest(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/courtesy-requests`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function reviewCourtesyRequest(venueId, eventId, id, payload) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/courtesy-requests/${id}/review`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}
export function listRecoveries(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/recoveries`);
}
export function listResales(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/resales`);
}
export function createResale(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/resales`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function sellResale(venueId, eventId, id, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/resales/${id}/sell`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function getForecast(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/forecast`);
}
export function changeTicket(venueId, eventId, ticketId, payload) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/tickets/${ticketId}/change`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}
export function createBundle(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/bundle`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function publicResales(eventId) {
  return apiFetch(`/public/events/${eventId}/resales`);
}
export function requestResale(resaleId, payload) {
  return apiFetch(`/public/resales/${resaleId}/request`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function requestCheckoutRecovery(eventId, payload) {
  return apiFetch(`/public/events/${eventId}/recover-checkout`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
export function getCheckoutRecovery(token) {
  return apiFetch(`/public/checkout-recovery/${token}`);
}

// --- Doce frentes nuevos (mig 072) ---
export function getFeeConfig(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/fee-config`);
}
export function saveFeeConfig(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/fee-config`, {
    method: "PUT", body: JSON.stringify(payload),
  });
}
export function publicFees(eventId, ticketTypeId) {
  return apiFetch(`/public/events/${eventId}/fees?ticket_type_id=${ticketTypeId}`);
}
export function adminFeePreview(venueId, eventId, ticketTypeId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/fee-preview?ticket_type_id=${ticketTypeId}`);
}
export function getAccessRules(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/access-rules`);
}
export function saveAccessRules(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/access-rules`, {
    method: "PUT", body: JSON.stringify(payload),
  });
}
export function publicAccessRules(eventId) {
  return apiFetch(`/public/events/${eventId}/access-rules`);
}
export function lookupDoorTickets(venueId, eventId, query) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/door/lookup?q=${encodeURIComponent(query)}`,
  );
}
export function createManualAdmission(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/door/manual-admission`, {
    method: "POST", body: JSON.stringify(payload),
  });
}
export function listManualAdmissions(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/door/manual-admissions`);
}
export function listDisputes(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/disputes`);
}
export function createDispute(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/disputes`, {
    method: "POST", body: JSON.stringify(payload),
  });
}
export function updateDispute(venueId, eventId, disputeId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/disputes/${disputeId}`, {
    method: "PATCH", body: JSON.stringify(payload),
  });
}
export function listPolls(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/polls`);
}
export function createPoll(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/polls`, {
    method: "POST", body: JSON.stringify(payload),
  });
}
export function setPollStatus(venueId, eventId, pollId, status) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/polls/${pollId}`, {
    method: "PATCH", body: JSON.stringify({ status }),
  });
}
export function publicPolls(eventId) {
  return apiFetch(`/public/events/${eventId}/polls`);
}
export function votePoll(pollId, payload) {
  return apiFetch(`/public/polls/${pollId}/vote`, {
    method: "POST", body: JSON.stringify(payload),
  });
}
export function listRecordings(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/recordings`);
}
export function createRecording(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/recordings`, {
    method: "POST", body: JSON.stringify(payload),
  });
}
export function deleteRecording(venueId, eventId, recordingId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/recordings/${recordingId}`, {
    method: "DELETE",
  });
}
export function publicRecordings(eventId, ticketToken) {
  const suffix = ticketToken ? `?ticket_token=${encodeURIComponent(ticketToken)}` : "";
  return apiFetch(`/public/events/${eventId}/recordings${suffix}`);
}
export function listLotteries(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/lotteries`);
}
export function createLottery(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/lotteries`, {
    method: "POST", body: JSON.stringify(payload),
  });
}
export function drawLottery(venueId, eventId, lotteryId) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/lotteries/${lotteryId}/draw`,
    { method: "POST" },
  );
}
export function listLotteryWinners(venueId, eventId, lotteryId) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/lotteries/${lotteryId}/winners`,
  );
}
export function publicLotteries(eventId) {
  return apiFetch(`/public/events/${eventId}/lotteries`);
}
export function enterLottery(lotteryId, payload) {
  return apiFetch(`/public/lotteries/${lotteryId}/enter`, {
    method: "POST", body: JSON.stringify(payload),
  });
}
export function getLotteryWinner(token) {
  return apiFetch(`/public/lottery-winners/${token}`);
}
export function claimLotteryWinner(token) {
  return apiFetch(`/public/lottery-winners/${token}/claim`, { method: "POST" });
}
export function listRsvps(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/rsvps`);
}
export function updateRsvp(venueId, eventId, rsvpId, status) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/rsvps/${rsvpId}`, {
    method: "PATCH", body: JSON.stringify({ status }),
  });
}
export function createRsvp(eventId, payload) {
  return apiFetch(`/public/events/${eventId}/rsvp`, {
    method: "POST", body: JSON.stringify(payload),
  });
}
export function getRsvp(token) {
  return apiFetch(`/public/rsvps/${token}`);
}
export function cancelRsvp(token) {
  return apiFetch(`/public/rsvps/${token}/cancel`, { method: "POST" });
}
export function getVenueProfile(venueId) {
  return apiFetch(`/venues/${venueId}/profile`);
}
export function saveVenueProfile(venueId, payload) {
  return apiFetch(`/venues/${venueId}/profile`, {
    method: "PUT", body: JSON.stringify(payload),
  });
}
export function publicVenueProfile(venueId) {
  return apiFetch(`/public/venues/${venueId}/profile`);
}
export function getStaffingForecast(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/staffing-forecast`);
}
export function listLinkChecks(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/link-checks`);
}
export function runLinkCheck(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/link-checks`, {
    method: "POST", body: JSON.stringify(payload),
  });
}
export function getArchive(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/archive`);
}
export function saveArchive(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/archive`, {
    method: "PUT", body: JSON.stringify(payload),
  });
}
export function publicArchive(eventId) {
  return apiFetch(`/public/events/${eventId}/archive`);
}

/* -------------------------------------------------------------------------
 * Migración guiada, lote, búsqueda y salida (mig 073)
 * ---------------------------------------------------------------------- */
export function previewImport(venueId, payload) {
  return apiFetch(`/venues/${venueId}/imports/preview`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function applyImport(venueId, payload) {
  return apiFetch(`/venues/${venueId}/imports/apply`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function previewBulk(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/bulk/preview`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function applyBulk(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/bulk/apply`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function globalSearch(query, venueId) {
  const qs = new URLSearchParams({ q: query });
  if (venueId) qs.set("venue_id", String(venueId));
  return apiFetch(`/search?${qs.toString()}`);
}

export function fetchPurchaseReceipt(rawToken) {
  return postBlob("/public/purchase-receipt", rawToken);
}

export function getExitSummary(venueId) {
  return apiFetch(`/venues/${venueId}/exit-summary`);
}

export async function fetchVenueExport(venueId) {
  const token = getToken();
  const res = await fetch(`${BASE}/venues/${venueId}/export.json`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error("No pudimos exportar los datos");
  return res.blob();
}

// --- Preguntas posteriores a la compra (mig 075) --------------------------
export function fetchMyTicketQuestions(ticketId, credential) {
  return apiFetch(`/public/my-tickets/${ticketId}/questions`, {
    method: "POST",
    body: JSON.stringify(credential),
  });
}

export function saveMyTicketAnswer(ticketId, questionId, credential, answer) {
  return apiFetch(`/public/my-tickets/${ticketId}/questions/${questionId}`, {
    method: "PUT",
    body: JSON.stringify({ ...credential, answer }),
  });
}

export function fetchMyTicketStream(ticketId, credential) {
  return apiFetch(`/public/my-tickets/${ticketId}/stream`, {
    method: "POST",
    body: JSON.stringify(credential),
  });
}

export function correctMyTicketContact(ticketId, credential, payload) {
  return apiFetch(`/public/my-tickets/${ticketId}/contact`, {
    method: "POST",
    body: JSON.stringify({ ...credential, ...payload }),
  });
}

export function listEventQuestions(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/questions`);
}

export function createEventQuestion(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/questions`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateEventQuestion(venueId, eventId, questionId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/questions/${questionId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteEventQuestion(venueId, eventId, questionId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/questions/${questionId}`, {
    method: "DELETE",
  });
}

export function getEventAdmin(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}`);
}

export function updateEventAdmin(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Canal invitado (mig 077): boletas vendidas fuera de Enty
// ---------------------------------------------------------------------------
export function listExternalChannels(venueId, eventId) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/external-channels`);
}

export function createExternalChannel(venueId, eventId, payload) {
  return apiFetch(`/venues/${venueId}/events/${eventId}/external-channels`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateExternalChannel(venueId, eventId, channelId, payload) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/external-channels/${channelId}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );
}

export function importExternalTickets(venueId, eventId, channelId, payload) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/external-channels/${channelId}/import`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function listExternalTickets(venueId, eventId, channelId, status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/external-channels/${channelId}/tickets${qs}`,
  );
}

export function getExternalReconciliation(venueId, eventId, channelId) {
  return apiFetch(
    `/venues/${venueId}/events/${eventId}/external-channels/${channelId}/reconciliation`,
  );
}
