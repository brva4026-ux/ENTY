/**
 * Nucleo de i18n (sin React, testeable con node --test).
 *
 * El catalogo es un objeto anidado por namespace (`login.title`,
 * `login.errors.network`). `translate` camina la ruta y, si falta la clave,
 * DEVUELVE LA CLAVE: un texto sin traducir se ve como `login.title` en vez de
 * romper el render, y el test de paridad lo detecta antes de desplegar.
 *
 * Interpolacion minima: `{name}` en la cadena se sustituye por vars.name.
 */

export const LOCALES = ["es", "en"];
export const DEFAULT_LOCALE = "es";

/** Ruta "a.b.c" -> valor en el objeto anidado (o undefined). */
export function lookup(catalog, key) {
  return key.split(".").reduce((o, k) => (o == null ? o : o[k]), catalog);
}

/**
 * Traduce una clave con el catalogo dado.
 * @param {object} catalog
 * @param {string} key
 * @param {object} [vars] valores para `{marcadores}`
 */
export function translate(catalog, key, vars) {
  const raw = lookup(catalog, key);
  if (typeof raw !== "string") return key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
  );
}

/** Lista de rutas de hoja ("a.b.c") de un catalogo. Sirve al test de paridad. */
export function flattenKeys(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenKeys(v, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}
