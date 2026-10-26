/**
 * Genera los iconos de la PWA y el favicon desde la imagen de marca.
 *
 * Por que existe: los PNG son build artifact, no fuente. Editarlos a mano era
 * como se desincronizaron del logo. Y el logo es un raster (JPEG) subido por
 * el usuario: NO se vectoriza — se recorta cuadrado, se escala y se rasteriza
 * con Chromium, el mismo motor que ya usan los e2e (sin dependencias nuevas).
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

const SOURCE = join(pub, "logo-vpass.jpg");
const SOURCE_URI = "data:image/jpeg;base64," + readFileSync(SOURCE).toString("base64");
/** Crema de la ilustracion: rellena la zona segura de los iconos maskable. */
const CREAM = "#faf9f6";

/** Carga la imagen una vez por pagina y devuelve sus dimensiones reales. */
const measure = (page) =>
  page.evaluate(
    (src) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error("no se pudo cargar " + src.slice(0, 40)));
        img.src = src;
      }),
    SOURCE_URI,
  );

/**
 * Rasteriza el recorte cuadrado centrado, escalado a `size`.
 * `inset` (0..1] encoge el arte dentro del lienzo: los maskable necesitan
 * ~20% de margen o el launcher recorta la ilustracion.
 */
async function render(page, size, file, inset = 1) {
  const { w, h } = await measure(page);
  const side = Math.min(w, h);
  const inner = Math.round(size * inset);
  const offset = Math.round((size - inner) / 2);

  // object-fit:cover sobre un cuadrado hace el recorte centrado sin deformar.
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:${CREAM}">
       <div style="position:relative;width:${size}px;height:${size}px;overflow:hidden">
         <img src="${SOURCE_URI}" alt="" style="
           position:absolute;top:${offset}px;left:${offset}px;
           width:${inner}px;height:${inner}px;
           object-fit:cover;object-position:center;display:block" />
       </div>
     </body></html>`,
    { waitUntil: "load" },
  );
  await page.locator("img").waitFor({ state: "visible" });
  await page.screenshot({ path: join(outDir, file), omitBackground: true });
  console.log(`[icons] ${file} (${size}x${size}${inset < 1 ? ", maskable" : ""})`);
}

/** Favicon de 32px embebido como data-URI PNG en index.html. */
async function syncFavicon(page) {
  await page.setViewportSize({ width: 32, height: 32 });
  await page.setContent(
    `<!doctype html><html><body style="margin:0">
       <img src="${SOURCE_URI}" alt="" style="
         width:32px;height:32px;object-fit:cover;object-position:center;display:block" />
     </body></html>`,
    { waitUntil: "load" },
  );
  const png = await page.locator("img").screenshot();
  const uri = "data:image/png;base64," + png.toString("base64");

  const file = join(root, "index.html");
  let html = readFileSync(file, "utf8");
  const re = /<link rel="icon" href="data:image\/(?:svg\+xml|png);base64,[^"]*" \/>/;
  if (!re.test(html)) throw new Error("index.html: no se encontro el favicon data-URI");
  writeFileSync(file, html.replace(re, `<link rel="icon" href="${uri}" />`));
  console.log("[icons] favicon inline sincronizado en index.html");
}

const main = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  await render(page, 192, "icon-192.png");
  await render(page, 512, "icon-512.png");
  await render(page, 180, "apple-touch-icon.png");
  await render(page, 192, "icon-maskable-192.png", 0.8);
  await render(page, 512, "icon-maskable-512.png", 0.8);
  await syncFavicon(page);

  await browser.close();
};

await main();
