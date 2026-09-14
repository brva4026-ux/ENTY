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
    const detail = data?.detail;
    const msg = typeof detail === "string" ? detail : "Error en la petición";
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}