/**
 * Coalescencia y micro-caché de peticiones GET.
 *
 * Dos pantallas que se montan juntas piden el mismo recurso (la vitrina pide el
 * catálogo y el detalle del evento destacado, dos componentes piden el resumen
 * de la venue, etc.). Sin esto, cada una abre su propia ida y vuelta a la red:
 * el usuario paga dos veces la latencia y el backend dos veces la consulta.
 *
 * Reglas:
 *   - Solo GET sin cuerpo. Un POST/PATCH/DELETE nunca se comparte: muta estado
 *     y su respuesta no es reutilizable.
 *   - En vuelo (inflight): mientras una petición idéntica está en curso, la
 *     segunda se engancha a la MISMA promesa. Al resolverse, las dos reciben el
 *     mismo objeto. Si la primera falla, la segunda también (misma causa).
 *   - Reciente (fresh): durante `ttlMs` una respuesta exitosa se reutiliza sin
 *     red. TTL corto y por defecto 0 (desactivado): el micro-caché solo donde
 *     el dato es de lectura casi pura (catálogo público). Los paneles con datos
 *     de negocio (boletas, caja) NO lo usan: ahí un dato viejo es peor que una
 *     petición de más.
 *
 * El llamador puede pedir el dato fresco con `fresh: true` (bypassa la capa
 * reciente, pero NO la coalescencia en vuelo: dos refrescos simultáneos siguen
 * siendo una sola petición).
 */

const inflight = new Map(); // key -> Promise
const fresh = new Map(); // key -> { at, data }

export function cacheKey(method, path, token) {
  // El token entra en la clave: la misma URL con sesiones distintas no debe
  // devolver el dato de otro usuario desde la capa reciente.
  return `${method.toUpperCase()} ${path} ${token ? "auth" : "anon"}`;
}

/**
 * Envuelve una promesa de fetch con coalescencia y, opcionalmente, TTL.
 * `run` se llama como máximo una vez por ventana en vuelo.
 */
export function dedupeGet(key, run, { ttlMs = 0, bypass = false } = {}) {
  if (!bypass && ttlMs > 0) {
    const hit = fresh.get(key);
    if (hit && Date.now() - hit.at < ttlMs) {
      return Promise.resolve(hit.data);
    }
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  const p = run().then(
    (data) => {
      if (ttlMs > 0) fresh.set(key, { at: Date.now(), data });
      return data;
    },
    (err) => {
      // Un fallo no se cachea: el siguiente intento vuelve a la red.
      throw err;
    },
  );
  inflight.set(key, p);
  // Se libera SIEMPRE (éxito o error) para que la clave no quede pegada.
  p.finally(() => inflight.delete(key)).catch(() => {});
  return p;
}

/** Invalida una clave concreta (tras una mutación que la deja obsoleta). */
export function invalidate(key) {
  fresh.delete(key);
}

/** Invalida todo lo que empiece por `prefix` (p.ej. "/venues/3/"). */
export function invalidatePrefix(prefix) {
  for (const k of fresh.keys()) {
    if (k.includes(prefix)) fresh.delete(k);
  }
}

/** Solo para tests: limpia las dos capas. */
export function __reset() {
  inflight.clear();
  fresh.clear();
}
