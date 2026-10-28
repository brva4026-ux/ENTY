#!/usr/bin/env node
/**
 * Genera el kit de logotipo en public/brand/: lockup horizontal y apilado,
 * wordmark y monocromos.
 *
 * El texto va TRAZADO A CURVAS, no como texto vivo: un logo tiene que escalar,
 * cortarse y reproducirse igual en cualquier sistema, sin depender de que Sora
 * este instalada. Los contornos salen de Sora 800 (el peso de marca) instanciado
 * con fontTools desde public/fonts/sora-latin.woff2.
 *
 * Los monocromos aplanan el isotipo a UNA tinta: fuera degradados, resplandores
 * y transparencias, que la imprenta, el bordado y el fax no reproducen. Si el
 * isotipo cambia, hay que volver a auditar que el monocromo siga teniendo un
 * solo color y cero degradados.
 *
 * Uso: npm run logo-kit   (requiere fonttools: pip install fonttools brotli)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { markSvg } from "./src/lib/brandMark.js";

const root = dirname(fileURLToPath(import.meta.url));
const pub = join(root, "public");
const outDir = join(pub, "brand");

const INK = "#f5eedd";
const ACCENT = "#4fe3ff";

/* ------------------------------------------------------------------ trazado */

const TRACE = `
import json, re, sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

font_path, out = sys.argv[1], sys.argv[2]
font = TTFont(font_path)
# Sora es variable: se instancia en el peso de marca, no se usa el default.
inst = instantiateVariableFont(font, {"wght": 800}, inplace=False)
gs, cmap = inst.getGlyphSet(), inst.getBestCmap()
cap = inst["OS/2"].sCapHeight

TRACK, MARGIN = 40, 340        # 0.04em de tracking; 0.34em alrededor de la barra
BAR_W, BAR_H = 500, 90

def outline(ch, x):
    pen = SVGPathPen(gs)
    # y se invierte y la linea base sube a y=cap: el SVG crece hacia abajo.
    gs[cmap[ord(ch)]].draw(TransformPen(pen, Transform(1, 0, 0, -1, x, cap)))
    return pen.getCommands(), gs[cmap[ord(ch)]].width

def rnd(d):
    return re.sub(r"-?\\d+\\.\\d+",
                  lambda m: ("%.2f" % float(m.group())).rstrip("0").rstrip("."), d)

parts, x = [], 0
d, adv = outline("V", x); parts.append(["V", rnd(d)]); x += adv + MARGIN
bar_x0 = x; x += BAR_W + MARGIN
for ch in "PASS":
    d, adv = outline(ch, x); parts.append([ch, rnd(d)]); x += adv + TRACK

json.dump({"cap": cap, "total": x - TRACK,
           "bar": [bar_x0, cap // 2 - BAR_H // 2, BAR_W, BAR_H],
           "parts": parts}, open(out, "w"))
`;

function traceOutlines() {
  const dir = mkdtempSync(join(tmpdir(), "vpass-kit-"));
  const script = join(dir, "trace.py");
  const json = join(dir, "outlines.json");
  writeFileSync(script, TRACE);
  execFileSync("python3", [script, join(pub, "fonts", "sora-latin.woff2"), json]);
  return JSON.parse(readFileSync(json, "utf8"));
}

/* ------------------------------------------------------------------- dibujo */

const wm = traceOutlines();
const { cap, total } = wm;
const [barX, barY, barW, barH] = wm.bar;

/** Los cinco contornos: la V en acento, el resto en tinta. */
const glyphs = (ink, accent) =>
  wm.parts.map(([, d], i) => `<path d="${d}" fill="${i === 0 ? accent : ink}"/>`).join("");

/** La barra de marca: el guion tipografico, resuelto como bloque. */
const bar = (color, opacity = "") =>
  `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="${color}"${
    opacity ? ` opacity="${opacity}"` : ""
  }/>`;

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="V-Pass"><title>V-Pass</title>${body}</svg>`;

/** El isotipo aplanado a una sola tinta. */
function flatMark(ink) {
  let m = markSvg({ idp: "mono", size: 64 })
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "");
  m = m.replace(/<defs>[\s\S]*?<\/defs>/, "");
  m = m.replace(/clip-path="url\([^)]*\)"/g, ""); // sin degradado no hay nada que recortar
  m = m.replace(/fill="url\([^)]*\)"/g, `fill="${ink}"`);
  m = m.replace(/stroke="url\([^)]*\)"/g, `stroke="${ink}"`);
  // Quedan tintas directas (nucleo, destello, anillo): tambien son una tinta.
  m = m.replace(/#[0-9a-fA-F]{6}\b/g, ink);
  m = m.replace(/#[0-9a-fA-F]{3}\b/g, ink);
  m = m.replace(/\s(?:opacity|fill-opacity|stroke-opacity)="[^"]*"/g, "");
  return m;
}

const H = 64;
const CAP_TARGET = 46; // altura de mayusculas del wordmark dentro del lockup
const scale = CAP_TARGET / cap;
const gap = 16;
const lockupW = H + gap + Math.round(total * scale);
const yOff = Math.round((H - CAP_TARGET) / 2);
const mark = markSvg({ idp: "lk", size: H })
  .replace(/^<svg[^>]*>/, "")
  .replace(/<\/svg>$/, "");

const written = [];
const write = (name, content) => {
  writeFileSync(join(outDir, name), content);
  written.push(name);
};

// Wordmark: solo la palabra.
write("vpass-wordmark.svg", svg(total, cap, glyphs(INK, ACCENT) + bar(ACCENT, 0.55)));
write("vpass-wordmark-mono.svg", svg(total, cap, glyphs("#000000", "#000000") + bar("#000000")));

// Lockup horizontal: isotipo + palabra.
const wordGroup = (ink, accent) =>
  `<g transform="translate(${H + gap} ${yOff}) scale(${scale.toFixed(5)})">${glyphs(ink, accent)}${bar(
    accent,
    0.55,
  )}</g>`;
write("vpass-lockup.svg", svg(lockupW, H, mark + wordGroup(INK, ACCENT)));

// Lockup apilado: el horizontal es 6:1 y se encoge mal, este respira.
const stackW = Math.max(H, Math.round(total * scale));
const stackH = H + 16 + Math.round(cap * scale);
write(
  "vpass-lockup-stacked.svg",
  svg(
    stackW,
    stackH,
    `<g transform="translate(${Math.round((stackW - H) / 2)} 0)">${mark}</g>` +
      `<g transform="translate(0 ${H + 16}) scale(${scale.toFixed(5)})">${glyphs(INK, ACCENT)}${bar(
        ACCENT,
        0.55,
      )}</g>`,
  ),
);

// Monocromos: una tinta, cero degradados.
for (const [name, ink] of [
  ["vpass-lockup-black.svg", "#000000"],
  ["vpass-lockup-white.svg", "#ffffff"],
]) {
  write(
    name,
    svg(
      lockupW,
      H,
      flatMark(ink) +
        `<g transform="translate(${H + gap} ${yOff}) scale(${scale.toFixed(5)})">${glyphs(
          ink,
          ink,
        )}${bar(ink)}</g>`,
    ),
  );
}

console.log(`[logo-kit] ${written.length} archivos en public/brand/`);
for (const n of written) console.log(`  · ${n}`);
