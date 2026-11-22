/**
 * Cliente Web Push (frontend).
 *
 * Flujo: el backend expone su clave pública VAPID (GET /push/public-key);
 * el navegador suscribe el dispositivo (pushManager.subscribe) y la
 * suscripción se registra en POST /push/subscribe. Cuando el admin abre
 * puertas, el backend notifica y el service worker muestra el aviso
 * (handlers push/notificationclick en public/sw.js).
 */
import { apiFetch } from "./api";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/** ¿El dispositivo/navegador soporta Web Push con service worker? */
export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Estado del backend: { public_key, enabled }. enabled=false => ocultar UI. */
export async function fetchPushConfig() {
  return apiFetch("/push/public-key");
}

/** Suscripción activa de este navegador (o null). */
export async function getCurrentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/** Permiso real del navegador: default | granted | denied | unsupported. */
export function pushPermission() {
  if (!pushSupported()) return "unsupported";
  return Notification.permission;
}

/** Estado confirmado por el servidor para el endpoint de este dispositivo. */
export async function fetchPushStatus(venueId, { endpoint, permission, subscribed }) {
  const qs = new URLSearchParams({ venue_id: String(venueId) });
  if (endpoint) qs.set("endpoint", endpoint);
  qs.set("permission", permission || "default");
  qs.set("subscribed", subscribed ? "true" : "false");
  return apiFetch(`/push/status?${qs.toString()}`);
}

/** Registra una suscripción ya existente sin volver a pedir permiso. */
export async function registerPushSubscription(venueId, sub) {
  const json = sub.toJSON();
  await apiFetch("/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      venue_id: venueId,
      endpoint: json.endpoint,
      keys: json.keys,
    }),
  });
  return json.endpoint;
}

/** Reintenta el registro de una suscripción local ya concedida. */
export async function retryPushRegistration(venueId) {
  const sub = await getCurrentSubscription();
  if (!sub) throw new Error("Este dispositivo no tiene una suscripción local.");
  return registerPushSubscription(venueId, sub);
}

/** Aviso de prueba SOLO a este dispositivo. */
export async function sendTestPush(venueId, endpoint) {
  return apiFetch("/push/test", {
    method: "POST",
    body: JSON.stringify({ venue_id: venueId, endpoint }),
  });
}

/**
 * Activa los avisos: pide permiso, suscribe el dispositivo y registra la
 * suscripción en el backend para la venue dada. Lanza Error con mensaje
 * accionable si el usuario deniega el permiso o el navegador no soporta push.
 */
export async function enablePush(venueId) {
  if (!pushSupported()) {
    throw new Error("Este navegador no soporta notificaciones push");
  }
  const config = await fetchPushConfig();
  if (!config.enabled || !config.public_key) {
    throw new Error("Las notificaciones no están configuradas en el servidor");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Permiso de notificaciones denegado");
  }

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.public_key),
    }));

  await registerPushSubscription(venueId, sub);
  return sub;
}

/** Desactiva los avisos: cancela la suscripción local y la del backend. */
export async function disablePush() {
  const sub = await getCurrentSubscription();
  if (!sub) return;
  let endpoint = null;
  try {
    endpoint = sub.endpoint;
  } catch {
    /* suscripción ya inválida */
  }
  try {
    await sub.unsubscribe();
  } catch {
    /* seguir: lo importante es borrarla del backend */
  }
  if (endpoint) {
    await apiFetch("/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    });
  }
}
