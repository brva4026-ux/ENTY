/**
 * Genera los iconos de la PWA desde los SVG maestros y sincroniza el favicon
 * inline del index.html.
 *
 * Por que existe: los PNG son build artifact, no fuente. Editarlos a mano
 * era como se desincronizaron del logo (el navegador tenia el azul viejo
 * mientras el header tenia el navy). Ademas .gitignore traia `*.png` global,
 * asi que los PNG de public/ NUNCA entraron al repo y en produccion esos 4
 * archivos devolvian el index.html de la SPA en vez de la imagen: el
 * manifiesto declaraba 5 iconos y 4 no existian.
 *
 * Uso:  npm run icons
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";

const root = dirname(fileURLToPath(import.meta.url));
const pub = join(root, "public");
const outDir = join(pub, "icons");
mkdirSync(outDir, { recursive: true });

/**
 * Favicon de 32px: REDUCCION, no miniatura. A 16px reales el ojo (1.8px) y
 * el codigo de barras (1.5px) son ruido, asi que se caen. Quedan las tres
 * formas que la marca necesita: el campo navy, la boleta con su troquel y
 * la llama. Mismo path que public/icon.svg — 512/32 = 16.
 */
const FAVICON_MARKUP = [
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>",
  "<rect width='32' height='32' rx='7' fill='#16255c'/>",
  "<g transform='scale(0.0625)'>",
  // la llama
  "<path fill='#f97316' d='M256 40c40 64 88 108 88 168a88 88 0 0 1-176 0c0-36 18-58 42-70-4 30 5 46 23 53-14-49-9-95 23-151Z'/>",
  // la boleta
  "<rect x='112' y='292' width='288' height='132' rx='20' fill='#f5e6c8'/>",
  // troquel (a 16px son 1.7px: se ven como muescas, y esa es la firma)
  "<circle cx='112' cy='353' r='27' fill='#16255c'/>",
  "<circle cx='400' cy='353' r='27' fill='#16255c'/>",
  "</g></svg>",
].join("");

/** Mismo SVG, en un data-URI que no necesita encodeURIComponent. */
const svgToDataUri = (svg) =>
  "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");

/** Reemplaza el <link rel="icon"> con data-URI del index.html. */
function syncFavicon() {
  const file = join(root, "index.html");
  let html = readFileSync(file, "utf8");
  const tag = `<link rel="icon" href="${svgToDataUri(FAVICON_MARKUP)}" />`;
  const re = /<link rel="icon" href="data:image\/svg\+xml,[^"]*" \/>/;
  if (!re.test(html)) throw new Error("index.html: no se encontro el favicon data-URI");
  html = html.replace(re, tag);
  writeFileSync(file, html);
  console.log("[icons] favicon inline sincronizado en index.html");
}

/**
 * Rasteriza un SVG al tamano exacto. Chromium no escala el SVG si el
 * contenedor no esta exacto, asi que se fija width/height en px y se
 * captura sin margenes ni scrollbar.
 */
async function render(page, svg, size, file) {
  const uri = svgToDataUri(svg);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">
       <img src="${uri}" width="${size}" height="${size}"
            style="display:block;width:${size}px;height:${size}px" />
     </body></html>`,
    { waitUntil: "load" },
  );
  await page.locator("img").waitFor({ state: "visible" });
  await page.screenshot({ path: join(outDir, file), omitBackground: true });
  console.log(`[icons] ${file} (${size}x${size})`);
}

const main = async () => {
  const icon = readFileSync(join(pub, "icon.svg"), "utf8");
  const maskable = readFileSync(join(pub, "icon-maskable.svg"), "utf8");

  syncFavicon();

  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  await render(page, icon, 192, "icon-192.png");
  await render(page, icon, 512, "icon-512.png");
  await render(page, icon, 180, "apple-touch-icon.png");
  await render(page, maskable, 192, "icon-maskable-192.png");
  await render(page, maskable, 512, "icon-maskable-512.png");

  await browser.close();
};

await main();
