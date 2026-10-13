// Recalcula los hashes sha256 de los <script> inline de frontend/dist/index.html.
//
// La CSP (vercel.json + frontend/server.mjs) autoriza esos scripts por hash, no
// con 'unsafe-inline'. Si cambia el HTML inline (anti-flash de tema, registro del
// service worker), los hashes dejan de coincidir y la CSP bloquea el script:
// el sitio sigue funcionando, pero pierde el anti-flash y el SW.
//
// Uso:  node scripts/csp-hashes.mjs            (requiere build previo)
//       node scripts/csp-hashes.mjs ruta.html  (o un HTML puntual)
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const htmlPath = process.argv[2] || "frontend/dist/index.html";
const html = await readFile(htmlPath, "utf8");

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length === 0) {
  console.error(`Sin <script> inline en ${htmlPath}`);
  process.exit(1);
}

const hashes = scripts.map(
  (s) => "sha256-" + createHash("sha256").update(s).digest("base64"),
);
console.log(hashes.join(" "));
