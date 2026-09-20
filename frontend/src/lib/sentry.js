/**
 * Sentry para el frontend: error tracking de los 500 que la UI traduce a
 * "Error en la petición" y de los crashes de React que atrapa el ErrorBoundary.
 *
 * Sin `VITE_SENTRY_DSN` TODO es no-op: no se importa el SDK ni se envía nada.
 * Por eso el import del SDK es dinámico — el bundle de los usuarios no carga
 * ~50 KB de Sentry si el proyecto no tiene DSN configurada.
 */

let initialized = false;

/** Devuelve true si Sentry quedó activo (hay DSN y el SDK cargó). */
export async function initFrontendSentry() {
  if (initialized) return true;
  const dsn = (import.meta.env.VITE_SENTRY_DSN ?? "").trim();
  if (!dsn) return false;
  try {
    const Sentry = await import("@sentry/react");
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE || "production",
      // Solo errores: sin traces ni replay (cuota mínima, señal máxima).
      tracesSampleRate: 0,
      replaysSessionSampleRate: 0,
      sendDefaultPii: false, // nunca PII del usuario
    });
    initialized = true;
    return true;
  } catch {
    return false; // sin Sentry la app funciona exactamente igual
  }
}

/** Reporta un error de forma segura (no-op sin DSN o si algo falla). */
export function captureError(error, context = {}) {
  if (!initialized) return;
  try {
    import("@sentry/react").then((Sentry) => {
      Sentry.captureException(error, { extra: context });
    });
  } catch {
    /* ignore */
  }
}

/** Reporta un error HTTP con el contexto que ayuda a ubicarlo. */
export function captureApiError(error, { method = "", path = "", status = 0 } = {}) {
  captureError(error, { kind: "api_error", method, path, status });
}
