/**
 * Analítica de producto: el embudo de la vitrina a la compra.
 *
 * Por qué no un SaaS: el CSP de la app es `script-src 'self'` (vercel.json).
 * Meter el script de un proveedor obliga a abrirlo y, en la práctica, a un
 * banner de cookies. Estos eventos van al PROPIO backend
 * (POST /api/public/analytics/events) y se guardan en nuestra DB: sin cookies,
 * sin terceros, sin datos personales. El id de sesión vive en `sessionStorage`
 * y muere al cerrar la pestaña, así que solo sirve para contar sesiones.
 *
 * Reglas de oro:
 *   - Nunca rompe la app: sin red, sin sessionStorage o con DNT activo, es no-op.
 *   - Nunca bloquea: los envíos son `keepalive` en segundo plano, agrupados, y
 *     al ocultar la pestaña se mandan con `sendBeacon` (fetch muere al navegar).
 */

const ENDPOINT = "/api/public/analytics/events";
const SID_KEY = "tf_sid";
const MAX_BATCH = 10;
const FLUSH_MS = 2000;

let sid = "";
let queue = [];
let timer = null;
let listening = false;

/** Id aleatorio por pestaña. Sin cookies: no sobrevive al cierre. */
function sessionId() {
  if (sid) return sid;
  try {
    const saved = sessionStorage.getItem(SID_KEY);
    if (saved) {
      sid = saved;
      return sid;
    }
    const fresh = crypto.randomUUID().replace(/-/g, "");
    sessionStorage.setItem(SID_KEY, fresh);
    sid = fresh;
    return sid;
  } catch {
    // Modo privado o sessionStorage bloqueado: id efímero solo en memoria.
    sid = sid || `mem${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    return sid;
  }
}

function send(events, beacon = false) {
  if (!events.length) return;
  const body = JSON.stringify({ session_id: sessionId(), events });
  try {
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      /* sin red: se pierde el lote, la experiencia sigue */
    });
  } catch {
    /* nunca propagar: la analítica jamás tumba una pantalla */
  }
}

/** Envía ya lo que haya en cola (lo usa el cierre de pestaña). */
export function flushAnalytics() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const events = queue;
  queue = [];
  send(events);
}

/**
 * Registra un paso del embudo.
 * `eventId` se manda aparte porque el backend lo guarda en su propia columna
 * (permite cruzar la sesión con el evento y su venue).
 */
export function track(name, { eventId = null, ...props } = {}) {
  if (typeof window === "undefined") return;
  if (navigator.doNotTrack === "1") return;

  queue.push({
    name,
    path: window.location.pathname.slice(0, 200),
    event_id: eventId ?? null,
    props: props && Object.keys(props).length ? props : null,
  });

  if (queue.length >= MAX_BATCH) {
    flushAnalytics();
    return;
  }
  if (!timer) timer = setTimeout(() => flushAnalytics(), FLUSH_MS);
}

// Al ocultar/cerrar la pestaña, sendBeacon: es el único envío que sobrevive a
// la navegación. Sin esto se perdería justo el último paso del embudo.
if (typeof document !== "undefined" && !listening) {
  listening = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden" || !queue.length) return;
    const events = queue;
    queue = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    send(events, true);
  });
}
