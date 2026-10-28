/**
 * Genera los iconos de la PWA y el favicon desde el isotipo V-Pass.
 *
 * Por que existe: los PNG son build artifact, no fuente. Editarlos a mano era
 * como se desincronizaron del logo. La forma vive en src/lib/brandMark.js (un
 * solo lugar, compartido con el componente React), y aqui se rasteriza con
 * Chromium — el mismo motor de los e2e, sin dependencias nuevas.
 *
 * El isotipo es vectorial, asi que ya no hay recorte cuadrado que destruya el
 * arte: antes el JPEG (2342x1792) se recortaba a un cuadrado y el icono salia
 * descentrado.
 *
 * Uso:  npm run icons
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";
import { markSvg } from "./src/lib/brandMark.js";
import { flashSvg } from "./src/lib/brandFlash.js";

const root = dirname(fileURLToPath(import.meta.url));
const pub = join(root, "public");
const outDir = join(pub, "icons");
mkdirSync(outDir, { recursive: true });

/** Tinta de la placa: rellena la zona segura de los iconos maskable. */
const BADGE_BG = "#0b0d16";

/**
 * Tinta del boleto dentro del icono. Los iconos van sobre la placa oscura, y
 * `currentColor` no resuelve fuera del DOM: aqui hay que dar la tinta explicita.
 */
const ICON_INK = "#f5eedd";

/**
 * Rasteriza el isotipo a `size`.
 * `inset` (0..1] encoge el arte dentro del lienzo: los maskable necesitan
 * ~20% de margen o el launcher recorta la placa.
 */
async function render(page, size, file, inset = 1) {
  const inner = Math.round(size * inset);
  const svg = markSvg({ idp: "ic", size: inner, ink: ICON_INK });
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:${BADGE_BG};display:grid;place-items:center;width:${size}px;height:${size}px">
       ${svg}
     </body></html>`,
    { waitUntil: "load" },
  );
  await page.locator("svg").waitFor({ state: "visible" });
  await page.screenshot({ path: join(outDir, file), omitBackground: true });
  console.log(`[icons] ${file} (${size}x${size}${inset < 1 ? ", maskable" : ""})`);
}

/**
 * Tarjeta social (og:image): 1200x630 con el isotipo y el wordmark sobre la
 * tinta de marca. Antes era un PNG de la fase previa (paleta crema) que
 * desentonaba con el rediseno; ahora se rasteriza del mismo vector, asi que
 * la marca del preview social nunca se desincroniza.
 */
async function renderSocialCard(page) {
  const W = 1200;
  const H = 630;
  const font = readFileSync(join(pub, "fonts", "sora-latin.woff2")).toString("base64");
  // La pieza ilustrada, no el isotipo: el og-cover es la portada, y a 340px la
  // pieza se ve entera — es justo el tamano para el que esta dibujada.
  const svg = flashSvg({ idp: "og", size: 340 });
  await page.setViewportSize({ width: W, height: H });
  await page.setContent(
    `<!doctype html><html><head><style>
       @font-face{font-family:Sora;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:800}
       *{margin:0;box-sizing:border-box}
       body{width:${W}px;height:${H}px;background:#070c17;display:flex;align-items:center;
         gap:72px;padding:0 96px;font-family:Sora,sans-serif;overflow:hidden;position:relative}
       body::before{content:"";position:absolute;inset:0;
         background:radial-gradient(58% 92% at 12% 0%, rgba(61,92,214,.42), transparent 68%),
                    radial-gradient(52% 74% at 92% 104%, rgba(79,227,255,.24), transparent 70%)}
       body::after{content:"";position:absolute;left:0;right:0;bottom:0;height:6px;
         background:linear-gradient(90deg,#3d5cd6,#4fe3ff)}
       .mark{position:relative;flex:none;filter:drop-shadow(0 24px 48px rgba(79,227,255,.28))}
       .copy{position:relative;min-width:0}
       /* El logotipo social usa los mismos elementos que la app — la V en tinta
          de acento y la barra de marca — pero con tracking negativo: a 118px el
          espaciado positivo del wordmark pequeño deshilacharia la palabra. El
          tracking escala al revés que el tamano. */
       h1{color:#f4f6fb;font-size:118px;font-weight:800;letter-spacing:-.03em;line-height:1;
         display:flex;align-items:center;text-transform:uppercase}
       h1 .v{color:#4fe3ff}
       h1 .sep{display:inline-block;width:.5em;height:.09em;margin:0 .34em;
         border-radius:999px;background:#4fe3ff;opacity:.55}
       p{color:#a9bbdb;font-size:36px;font-weight:400;margin-top:22px;max-width:620px;line-height:1.25}
     </style></head><body>
       <div class="mark">${svg}</div>
       <div class="copy">
         <h1><span class="v">V</span><span class="sep" aria-hidden="true"></span>PASS</h1>
         <p>Boletas, cortesias y control de aforo</p>
       </div>
     </body></html>`,
    { waitUntil: "load" },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(pub, "og-cover.png") });
  console.log(`[icons] og-cover.png (${W}x${H})`);
}

/** Favicon de 32px embebido como data-URI PNG en index.html. */
async function syncFavicon(page) {
  const size = 32;
  await page.setContent(
    `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px">
       ${markSvg({ idp: "fav", size, ink: ICON_INK })}
     </body></html>`,
    { waitUntil: "load" },
  );
  const png = await page.locator("svg").screenshot();
  const uri = "data:image/png;base64," + png.toString("base64");

  const file = join(root, "index.html");
  let html = readFileSync(file, "utf8");
  const re = /<link rel="icon" href="data:image\/(?:svg\+xml|png);base64,[^"]*" \/>/;
  if (!re.test(html)) throw new Error("index.html: no se encontro el favicon data-URI");
  writeFileSync(file, html.replace(re, `<link rel="icon" href="${uri}" />`));
  console.log("[icons] favicon inline sincronizado en index.html");
}

const main = async () => {
  // Chromium del sistema: el bundle de Playwright no siempre esta instalado
  // (en CI/contenedor el binario vive en /usr/bin/chromium). Igual que los
  // e2e, se prefiere el del sistema cuando existe.
  const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  await render(page, 192, "icon-192.png");
  await render(page, 512, "icon-512.png");
  await render(page, 180, "apple-touch-icon.png");
  await render(page, 192, "icon-maskable-192.png", 0.8);
  await render(page, 512, "icon-maskable-512.png", 0.8);
  await renderSocialCard(page);
  await syncFavicon(page);

  await browser.close();
};

await main();
