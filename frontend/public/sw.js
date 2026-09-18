/* TicketFlow service worker — app shell offline para la puerta.
 *
 * Objetivo: si el venue pierde internet, el portero aún puede ABRIR el
 * escáner (la validación de boletas obviamente requiere red; eso es
 * correcto: sin red no se puede canjear contra la DB).
 *
 * Estrategia: precache del app shell (HTML + bundles + manifest + iconos).
 * Navegaciones y assets /assets/* se sirven cache-first; la API NUNCA se
 * cachea (datos de boletas siempre frescos).
 */
// El BUILD_ID lo estampa replace-sw-version.js en dist/sw.js en cada build:
// al cambiar el contenido del archivo, el navegador instala el SW nuevo y
// purga las caches viejas (activate). Sin esto, cada deploy dejaba
// HTML/iconos obsoletos para los usuarios ya instalados.
const VERSION = "v1"; /*BUILD_ID*/
const SHELL_CACHE = `tf-shell-${VERSION}`;
const RUNTIME_CACHE = `tf-runtime-${VERSION}`;

const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ------------------------------------------------------------------
// Web Push: la puerta recibe el aviso aunque la app esté cerrada.
// ------------------------------------------------------------------
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "TicketFlow", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "TicketFlow";
  const options = {
    body: data.body || "",
    tag: data.tag || "ticketflow",
    renotify: true, // el tag repetido vuelve a vibrar: cada apertura importa
    vibrate: [80, 60, 80],
    badge: "/icons/icon-maskable-192.png",
    icon: "/icons/icon-192.png",
    data: { url: data.url || "/bouncer" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clic en la notificación: enfocar la app abierta o abrir el escáner.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/bouncer";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(target) && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 1. La API jamás se cachea: aforo y boletas deben ser datos vivos.
  if (url.pathname.startsWith("/api/")) return;

  // 2. Navegaciones (recargar el escáner sin red): cache-first con fallback
  //    a red, y si no hay ni cache ni red, el shell "/".
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req)
            .then((res) => {
              const copy = res.clone();
              caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
              return res;
            })
            .catch(() => caches.match("/"))
      )
    );
    return;
  }

  // 3. Assets de Vite (hash estable por build): cache-first y a runtime.
  if (url.pathname.startsWith("/assets/") || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
            return res;
          })
      )
    );
  }
});
