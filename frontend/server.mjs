// Servidor de producción para el frontend TicketFlow.
// - Sirve los archivos estaticos de ./dist (SPA con fallback a index.html)
// - Hace proxy de /api -> backend:8000 (mantiene el mismo origin, sin CORS)
// - Escucha en 0.0.0.0:PORT (por defecto 12000) y NO bloquea hosts (a
//   diferencia de `vite preview` que aplica proteccion DNS-rebinding).
//
// Uso: node server.mjs [port]   (o PORT=12000)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(__dirname, "dist");
const PORT = parseInt(process.env.PORT || process.argv[2] || "12000", 10);
const BACKEND = process.env.VITE_BACKEND_URL || process.argv[3] || "http://localhost:8000";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".map": "application/json",
};

// Cabeceras de seguridad del origen estatico. La CSP es la misma que
// vercel.json (los hashes sha256 son de los dos <script> inline de
// index.html: anti-flash de tema y registro del service worker). Si cambia
// ese HTML hay que recalcularlos con scripts/csp-hashes.mjs.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(self), geolocation=(self)",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; object-src 'none'; " +
    "frame-ancestors 'none'; form-action 'self'; " +
    "script-src 'self' 'sha256-BCxcTDZx8Ar4yrDqOW5obXLMOvXkpCVQOwye3Hq7Da8=' " +
    "'sha256-jUIYy3a/48gIItZqiYauF9EGma1BA1qQaffcsibxY0c='; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
    "font-src 'self'; connect-src 'self' https://*.sentry.io " +
    "https://*.ingest.sentry.io https://*.ingest.us.sentry.io " +
    "https://nominatim.openstreetmap.org; manifest-src 'self'; " +
    "worker-src 'self' blob:",
};

async function serveStatic(req, res, pathname) {
  let filePath = normalize(join(DIST, pathname));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end("forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(data);
  } catch {
    // SPA fallback: cualquier ruta que no sea archivo devuelve index.html
    try {
      const data = await readFile(join(DIST, "index.html"));
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
      });
      res.end(data);
    } catch {
      res.writeHead(500);
      res.end("dist no encontrado. Ejecuta: npm run build");
    }
  }
}

function proxyApi(req, res) {
  // Soporta targets http:// y https:// (Render inyecta https://...onrender.com)
  const isHttps = BACKEND.startsWith("https://");
  const transport = isHttps ? https : http;
  const [host, port] = BACKEND.replace(/^https?:\/\//, "").split(":");
  const upstream = transport.request(
    {
      host,
      port: port || (isHttps ? 443 : 80),
      path: req.url.replace(/^\/api/, ""),
      method: req.method,
      headers: { ...req.headers, host },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "Backend no disponible: " + err.message }));
  });
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "ticketflow-frontend" }));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    return proxyApi(req, res);
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[frontend] TicketFlow sirviendo en http://0.0.0.0:${PORT}`);
  console.log(`[frontend] dist=${DIST} backend=${BACKEND}`);
});