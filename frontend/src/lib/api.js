// Cliente API. En dev, Vite hace proxy de /api -> backend:8000.
// En producción el frontend se sirve junto al backend o via gateway.
const BASE = "/api";

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