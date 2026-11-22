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
 * Favicon de 32px: el símbolo de boleto sólido, sin texto ni detalles que se
 * pierdan a 16px. Usa el mismo path que public/icon.svg para que el favicon y
 * la marca del header no vuelvan a separarse.
 */
const FAVICON_MARKUP = [
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'>",
  "<rect width='48' height='48' rx='11' fill='#FFFDF8'/>",
  "<path fill='#690FD1' d='M7 12H41A3 3 0 0 1 44 15V20A4 4 0 0 0 44 28V33A3 3 0 0 1 41 36H7A3 3 0 0 1 4 33V28A4 4 0 0 0 4 20V15A3 3 0 0 1 7 12Z' transform='rotate(-25 24 24)'/>",
  "</svg>",
].join("");

/** Mismo SVG, en un data-URI que no necesita encodeURIComponent. */
const svgToDataUri = (svg) =>
  "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");

/** Reemplaza el <link rel="icon"> con data-URI del index.html. */
function syncFavicon() {
  const file = join(root, "index.html");
  let html = readFileSync(file, "utf8");
  const tag = `<link rel="icon" href="${svgToDataUri(FAVICON_MARKUP)}" />`;
  const re = /<link rel="icon" href="data:image\/svg\+xml[^"]*" \/>/;
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
