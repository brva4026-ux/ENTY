/** Misma forma que guarda el backend: sin @, sin tildes y en minúsculas. */
export function normalizeUsername(value) {
  let raw = (value || "").trim();
  if (raw.startsWith("@")) raw = raw.slice(1);
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Base del usuario generado por el servidor: nombre del negocio o, sin él,
 *  el nombre personal. Misma normalización que backend/app/core/usernames.py. */
export function usernameBase(value) {
  let base = normalizeUsername(value)
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/[._-]{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (base.length < 3) return "usuario";
  return base.slice(0, 32).replace(/[._-]+$/, "") || "usuario";
}

export function isValidUsername(value) {
  return /^[a-z0-9._-]{3,32}$/.test(normalizeUsername(value));
}
