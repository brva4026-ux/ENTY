/**
 * Modo offline de puerta: caché IndexedDB del snapshot + cola de sync.
 *
 * Modelo de seguridad (misma filosofía del server):
 * - La caché guarda SOLO los SHA-256 de las boletas vivas (los mismos hashes
 *   que ya guarda la DB). Un hash no sirve para emitir, reemitir ni clonar.
 * - Validar offline = comparar SHA-256 del token escaneado contra la lista.
 *   NO hay invento de estados: lo que la caché no conoce es "no confirmable"
 *   (NOT_IN_CACHE), nunca "válida" ni "no existe" — puede haberse emitido
 *   después de la descarga, y rechazarla sin red sería un error de puerta.
 * - Toda redención offline entra en una cola y se sincroniza con
 *   POST /door-sync cuando vuelve la red; la DB re-evalúa cada token con
 *   redeem_ticket y es el árbitro final (una boleta anulada después de
 *   descargar el snapshot queda rechazada al sincronizar).
 *
 * Limitación honesta que la UI debe comunicar: el snapshot es una foto del
 * momento de la descarga. Mientras dure la ventana offline, "YA USADA" solo
 * aparece si el canje lo hizo ESTE teléfono; dos teléfonos offline distintos
 * podrían dejar pasar la misma boleta, y el sync lo reconciliará como
 * already_redeemed en la DB.
 */

const DB_NAME = "ticketflow-door";
const DB_VERSION = 2;
const STORE_SNAPSHOT = "snapshot"; // key = eventId -> DoorSnapshotOut
const STORE_QUEUE = "queue"; // key = scanId -> DoorSyncItem

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SNAPSHOT)) {
        db.createObjectStore(STORE_SNAPSHOT);
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "scan_id" });
      } else if (event.oldVersion < 2) {
        // v1 encolaba con autoIncrement y SIN event_id: una cola global que se
        // enviaba entera contra el evento seleccionado, así que los tokens de
        // otro evento salían INVALID_EVENT y la entrada real no se registraba.
        // Los items viejos no se pueden reparar (no guardaban su evento) y ya
        // no son seguros: se descartan al migrar. Es una cola de puerta, no un
        // registro histórico: perderla es aceptable, mandarla al evento
        // equivocado no.
        db.deleteObjectStore(STORE_QUEUE);
        db.createObjectStore(STORE_QUEUE, { keyPath: "scan_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB no disponible"));
  });
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB error"));
  });
}

/** uuid v4 para identificar cada escaneo (idempotencia del sync, mig 034). */
function newScanId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback para contextos sin randomUUID (WebView viejo). El formato debe
  // ser uuid válido: el server lo castea a uuid.
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
    ).toString(16),
  );
}

/** SHA-256 hex del token crudo (Web Crypto; disponible en todos los navegadores con cámara). */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Descarga y guarda el snapshot del evento. Devuelve el snapshot guardado. */
export async function downloadSnapshot(venueId, eventId) {
  const snap = await apiFetchJson(
    `/venues/${venueId}/events/${eventId}/door-snapshot`,
  );
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_SNAPSHOT, "readwrite");
    await reqAsPromise(
      tx.objectStore(STORE_SNAPSHOT).put(snap, String(eventId)),
    );
  } finally {
    db.close();
  }
  return snap;
}

/** Snapshot cacheado del evento (o null si nunca se descargó). */
export async function getSnapshot(eventId) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_SNAPSHOT, "readonly");
    return (
      (await reqAsPromise(
        tx.objectStore(STORE_SNAPSHOT).get(String(eventId)),
      )) ?? null
    );
  } finally {
    db.close();
  }
}

/**
 * Validación offline de un token escaneado.
 * Devuelve { code, ticket_id?, customer_name?, redeemed } con la MISMA forma
 * de RedeemOut para que el escáner no tenga dos caminos de render.
 */
export async function validateOffline(rawToken, eventId, rowTypeId = null) {
  const snap = await getSnapshot(eventId);
  if (!snap) return { code: "SNAPSHOT_MISSING", redeemed: false };
  const hash = await sha256Hex(rawToken);
  const entry = snap.entries.find((e) => e.h === hash);
  // Hay snapshot, pero la boleta NO está en él: lo más probable es que se
  // emitiera DESPUÉS de descargar la caché (el snapshot es una foto). Eso NO
  // es "no existe": decir NOT_FOUND aquí rechazaría una boleta legítima en la
  // puerta, sin red y sin forma de comprobarlo. Se marca como NO CONFIRMABLE
  // (ámbar): que la DB decida al sincronizar, o que se resuelva con red.
  if (!entry) return { code: "NOT_IN_CACHE", redeemed: false };
  if (rowTypeId && entry.t && entry.t !== rowTypeId) {
    return { code: "WRONG_TYPE", redeemed: false };
  }
  // Ya canjeada EN ESTE teléfono (sigue en la cola sin sincronizar): el
  // snapshot es una foto previa, así que la boleta sigue apareciendo viva y
  // sin esta comprobación un doble escaneo offline daba verde dos veces.
  // Dos teléfonos offline distintos siguen siendo un hueco conocido: eso lo
  // reconcilia la DB al sincronizar.
  const queued = await findQueued(rawToken, eventId);
  if (queued) {
    return {
      code: "ALREADY_REDEEMED_OFFLINE",
      ticket_id: null,
      customer_name: entry.n ?? null,
      redeemed: false,
    };
  }
  // En la caché solo hay vivas: una boleta presente está "lista", no "usada".
  // El estado REAL lo escribe el sync; por eso se encola abajo.
  return {
    code: "GRANTED_OFFLINE",
    ticket_id: null,
    customer_name: entry.n ?? null,
    redeemed: true,
  };
}

/** El item de cola de este token para este evento, o null si no espera sync. */
export async function findQueued(rawToken, eventId) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_QUEUE, "readonly");
    const all = (await reqAsPromise(tx.objectStore(STORE_QUEUE).getAll())) ?? [];
    return (
      all.find(
        (it) =>
          it.raw_token === rawToken &&
          (eventId == null || String(it.event_id) === String(eventId)),
      ) ?? null
    );
  } finally {
    db.close();
  }
}

/** Encola una redención offline. Devuelve el scan_id (idempotencia del sync). */
export async function queueRedemption(
  rawToken,
  { scannedAt, typeId, eventId, doorId } = {},
) {
  // Dedupe: si este token ya espera sync para el evento, se reusa su scan_id
  // en vez de encolar una segunda entrada. Escanear A, B, A sin red no debe
  // contar como dos ingresos al sincronizar.
  const dup = await findQueued(rawToken, eventId);
  if (dup) return dup.scan_id;

  const scanId = newScanId();
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_QUEUE, "readwrite");
    await reqAsPromise(
      tx.objectStore(STORE_QUEUE).put({
        scan_id: scanId,
        raw_token: rawToken,
        event_id: eventId ?? null,
        scanned_at: scannedAt ?? new Date().toISOString(),
        ticket_type_id: typeId ?? null,
        // Puerta de origen (mig 042): viaja con el item para que el sync la
        // escriba igual que el canje en línea. Sin esto, las entradas
        // validadas sin red quedaban sin puerta y el reporte por acceso
        // subestimaba el trabajo de la puerta.
        door_id: doorId ?? null,
      }),
    );
    return scanId;
  } finally {
    db.close();
  }
}

/** Cuántos escaneos esperan sincronización (para el badge de la puerta). */
export async function pendingCount() {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_QUEUE, "readonly");
    return await reqAsPromise(tx.objectStore(STORE_QUEUE).count());
  } finally {
    db.close();
  }
}

/**
 * Sincroniza la cola del evento contra la DB.
 *
 * Solo se envían los items de ESTE evento: la cola es del teléfono, pero un
 * bouncer puede haber trabajado dos eventos en la noche, y mandar los tokens
 * del otro evento al endpoint equivocado los rechazaba (INVALID_EVENT) sin
 * registrar la entrada real.
 *
 * Borra SOLO los items que el server confirmó en `results` (por scan_id). Si
 * la red muere a mitad del POST, lo no confirmado queda en la cola y el
 * reintento es no-op gracias al recibo idempotente del server.
 */
export async function syncQueue(venueId, eventId) {
  const db = await openDb();
  let items = [];
  try {
    {
      const tx = db.transaction(STORE_QUEUE, "readonly");
      const all = (await reqAsPromise(tx.objectStore(STORE_QUEUE).getAll())) ?? [];
      items = all.filter(
        (it) => it.event_id == null || String(it.event_id) === String(eventId),
      );
    }
    if (items.length === 0)
      return { processed: 0, granted: 0, already_redeemed: 0, rejected: 0, results: [] };
    const out = await apiFetchJson(
      `/venues/${venueId}/events/${eventId}/door-sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          items.map((it) => ({
            raw_token: it.raw_token,
            scanned_at: it.scanned_at,
            ticket_type_id: it.ticket_type_id,
            door_id: it.door_id ?? null,
            scan_id: it.scan_id,
          })),
        ),
      },
    );
    // Solo lo confirmado sale de la cola. Si el server no devolvió `results`
    // (versión vieja), no se borra nada: se prefiere reintentar de más —el
    // recibo del server lo hace no-op— antes que perder una entrada.
    //
    // `INVALID` significa que la SQL del canje LANCÓ (deadlock, conexión
    // cortada), no que la boleta sea inválida: el server no dejó recibo, así
    // que borrarlo aquí perdería una entrada pagada. Se conserva para
    // reintentar; los rechazos reales (ALREADY_REDEEMED, NOT_FOUND, ...) sí
    // son definitivos y sí se borran.
    const confirmed = (out.results ?? [])
      .filter((r) => r.scan_id && r.code !== "INVALID")
      .map((r) => r.scan_id);
    if (confirmed.length > 0) {
      const tx = db.transaction(STORE_QUEUE, "readwrite");
      const store = tx.objectStore(STORE_QUEUE);
      for (const id of confirmed) store.delete(id);
    }
    return out;
  } finally {
    db.close();
  }
}

// apiFetch vive en lib/api.js que importa auth y otras cosas; para no arrastrar
// ese grafo (y ciclos) al service worker futuro, aquí va un fetch mínimo con
// el token de la app (misma clave que api.js).
async function apiFetchJson(path, init = {}) {
  const token = localStorage.getItem("tf_token");
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const err = new Error(`door-cache: ${path} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
