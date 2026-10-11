// Estampa un BUILD_ID único en dist/sw.js después de cada build de Vite.
//
// Problema que resuelve: el service worker tenía VERSION = "v1" fijo. Cada
// deploy nuevo dejaba el HTML y los iconos viejos cacheados indefinidamente
// (los usuarios veían la app anterior hasta que alguien editara sw.js a mano).
//
// Solución: tras `vite build` reemplazamos el marcador /*BUILD_ID*/ (que vive
// en public/sw.js y Vite copia tal cual a dist/) por un id único (timestamp
// + hash corto de git). Al cambiar el byte del archivo servido, el navegador
// detecta el SW nuevo, lo instala, activa y purga las caches tf-shell/tf-
// runtime de la versión anterior.
//
// Se sella SOLO dist/: el fuente public/sw.js conserva el marcador intacto
// para que el siguiente build también pueda sellarse.
//
// Se invoca desde "build": "vite build && node replace-sw-version.js".
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const MARKER = 'const VERSION = "v1"; /*BUILD_ID*/';
const ASSETS_MARKER = "const BUILD_ASSETS = []; /*BUILD_ASSETS*/";
const SW_PATH = "dist/sw.js";

let content;
try {
  content = readFileSync(SW_PATH, "utf8");
} catch {
  console.warn(`[sw-version] ${SW_PATH} no encontrado; ¿se ejecutó vite build?`);
  process.exit(0);
}

if (!content.includes(MARKER)) {
  console.warn("[sw-version] El marcador no está en dist/sw.js — no se sella.");
  process.exit(0);
}

// Assets con hash del build: JS/CSS de dist/assets. Se precachean en el
// install del SW para que la puerta tenga el escaner offline ya en su
// PRIMERA carga, sin depender de una segunda visita.
let assetList = [];
try {
  assetList = readdirSync("dist/assets")
    .filter((f) => /\.(js|css)$/.test(f))
    .map((f) => `/assets/${f}`);
} catch {
  console.warn("[sw-version] dist/assets no encontrado; precache sin bundles.");
}

let gitShort = "nogit";
try {
  gitShort = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  /* fuera de un repo git: basta el timestamp */
}

const buildId = `build-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${gitShort}`;
content = content.replace(MARKER, `const VERSION = "${buildId}";`);
if (content.includes(ASSETS_MARKER)) {
  content = content.replace(
    ASSETS_MARKER,
    `const BUILD_ASSETS = ${JSON.stringify(assetList)};`
  );
} else {
  console.warn("[sw-version] Marcador BUILD_ASSETS ausente — precache sin bundles.");
}
writeFileSync(SW_PATH, content);
console.log(
  `[sw-version] dist/sw.js con VERSION=${buildId}, ${assetList.length} assets precacheados`
);
