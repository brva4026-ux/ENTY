/**
 * Modo offline de puerta: caché IndexedDB del snapshot + cola de sync.
 *
 * Modelo de seguridad (misma filosofía del server):
 * - La caché guarda SOLO los SHA-256 de las boletas vivas (los mismos hashes
 *   que ya guarda la DB). Un hash no sirve para emitir, reemitir ni clonar.
 * - Validar offline = comparar SHA-256 del token escaneado contra la lista.
 *   NO hay invento de estados: lo que la caché no conoce es "desconocido",
 *   nunca "válida".
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
const DB_VERSION = 1;
const STORE_SNAPSHOT = "snapshot"; // key = eventId -> DoorSnapshotOut
const STORE_QUEUE = "queue"; // key = auto-inc -> DoorSyncItem

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SNAPSHOT)) {
        db.createObjectStore(STORE_SNAPSHOT);
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { autoIncrement: true });
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
  if (!entry) return { code: "NOT_FOUND", redeemed: false };
  if (rowTypeId && entry.t && entry.t !== rowTypeId) {
    return { code: "WRONG_TYPE", redeemed: false };
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

/** Encola una redención offline (idempotente por token mientras no sincronice). */
export async function queueRedemption(rawToken, { scannedAt, typeId } = {}) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_QUEUE, "readwrite");
    await reqAsPromise(
      tx.objectStore(STORE_QUEUE).add({
        raw_token: rawToken,
        scanned_at: scannedAt ?? new Date().toISOString(),
        ticket_type_id: typeId ?? null,
      }),
    );
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
 * Sincroniza la cola contra la DB. Borra SOLO los items que el server
 * aceptó procesar (la llamada procesa la cola completa en bloque).
 * Devuelve el DoorSyncOut del server, o lanza si la red sigue sin haber.
 */
export async function syncQueue(venueId, eventId) {
  const db = await openDb();
  let items = [];
  try {
    {
      const tx = db.transaction(STORE_QUEUE, "readonly");
      items = (await reqAsPromise(tx.objectStore(STORE_QUEUE).getAll())) ?? [];
    }
    if (items.length === 0) return { processed: 0, granted: 0, already_redeemed: 0, rejected: 0 };
    const out = await apiFetchJson(
      `/venues/${venueId}/events/${eventId}/door-sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(items),
      },
    );
    const tx = db.transaction(STORE_QUEUE, "readwrite");
    await reqAsPromise(tx.objectStore(STORE_QUEUE).clear());
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
