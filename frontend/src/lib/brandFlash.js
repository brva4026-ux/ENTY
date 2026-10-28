/**
 * LA PIEZA ILUSTRADA: el boleto troquelado, dibujado a mano.
 *
 * No es el isotipo. El isotipo (brandMark.js) es la marca funcional: 3-4 trazos,
 * pensada para leerse a 16px. Esta es la marca ilustrada: la pieza de portada,
 * og-cover, imprenta y packaging, con oficio de flash de tatuaje.
 *
 * Por que dos piezas y no una: son objetivos distintos y no se pueden tener los
 * dos en el mismo dibujo. Medido — esta pieza tiene ~40 trazos, y a 16px el
 * desgarro cae por debajo del pixel: se ve un rectangulo con una mancha. El
 * isotipo tiene 4. Un logo que tiene que funcionar a 16px no puede permitirse
 * el detalle que hace buena a una ilustracion. Conviven: una es la marca, la
 * otra es la reduccion dura.
 *
 * QUE HACE QUE PAREZCA DIBUJADO, Y NO ENSAMBLADO
 * - Contorno grueso y seguro (2.5) que define la silueta sin dudar.
 * - Los CANTOS DEL DESGARRO SON IRREGULARES: dientes de amplitud creciente hacia
 *   el vertice. Un borde recto lee vectorial; un borde roto lee arrancado a mano.
 * - HACHURADO a mano: lineas cortas paralelas en abanico, recortadas por la
 *   mascara del talon. Es el recurso del grabado, no un relleno plano.
 * - CHISPAS de movimiento en el vertice: recurso de flash para dar tension.
 * - El sello de validacion y el serial: datos impresos, no decoracion.
 *
 * UNA SOLA TINTA: la pieza no lleva color estructural. El desgarro es un CANAL
 * CALADO (mascara), no un trazo de color, asi que el negro solo se lee igual.
 * El cian es un unico punto en el serial; quitarlo no cambia la lectura.
 */

/** Caja del boleto dentro del lienzo de 64. */
const T = { x: 4.5, y: 11, w: 55, h: 42, r: 6.5 };

/** El troquel: la V. Bocas en el centro de cada muesca, vertice abajo. */
const V = { x0: 4.5, y0: 31.5, ax: 32, ay: 46, x1: 59.5 };

/** Ancho del canal calado. Es el grosor del desgarro. */
const CUT = 5.0;

/**
 * Cantos del desgarro: dientes irregulares a lo largo de cada brazo.
 *
 * La amplitud crece hacia el vertice (0.5 → 1.4): el desgarro arranca entero en
 * el borde del boleto y se deshilacha al llegar al centro, que es como rompe el
 * papel de verdad. `i % 2` alterna el lado del diente.
 */
function tornEdge(a, b, n) {
  let d = `M${a[0]} ${a[1]}`;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    const s = (i % 2 ? 1 : -1) * (0.5 + t * 0.9);
    d += ` L${(x + (-dy / L) * s).toFixed(2)} ${(y + (dx / L) * s).toFixed(2)}`;
  }
  return d;
}

/**
 * Hachurado: lineas cortas paralelas dentro de la caja x0,y0→x1,y1.
 *
 * Se recorta despues con la mascara del boleto, asi que las lineas pueden
 * desbordar la caja: lo que sobre, se cae. Es mas simple que calcular cada
 * interseccion, y el resultado es el mismo.
 */
function hatch(x0, y0, x1, y1, ang, step, n, ink) {
  const a = (ang * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const L = Math.hypot(x1 - x0, y1 - y0);
  let out = "";
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * step;
    const x = cx - dy * off;
    const y = cy + dx * off;
    out += `<line x1="${(x - dx * L / 2).toFixed(2)}" y1="${(y - dy * L / 2).toFixed(2)}" x2="${(x + dx * L / 2).toFixed(2)}" y2="${(y + dy * L / 2).toFixed(2)}" stroke="${ink}" stroke-width="0.7" stroke-linecap="round"/>`;
  }
  return out;
}

/** Chispas de movimiento en el vertice del desgarro. */
function sparks(ink) {
  let out = "";
  for (let i = 0; i < 5; i++) {
    const rad = ((-140 + i * 25) * Math.PI) / 180;
    const r0 = 7.2;
    const r1 = 7.2 + (i % 2 ? 3.4 : 5.2);
    out += `<line x1="${(V.ax + Math.cos(rad) * r0).toFixed(2)}" y1="${(V.ay + Math.sin(rad) * r0).toFixed(2)}" x2="${(V.ax + Math.cos(rad) * r1).toFixed(2)}" y2="${(V.ay + Math.sin(rad) * r1).toFixed(2)}" stroke="${ink}" stroke-width="1.1" stroke-linecap="round" opacity="${i % 2 ? 0.6 : 0.95}"/>`;
  }
  return out;
}

/**
 * Las tres tintas de la pieza.
 *
 * `paper` es la tinta del papel del boleto. Si va `null`, la pieza se dibuja
 * como LINE ART: sin masa de papel, la silueta la define solo el contorno. Es
 * lo que necesitan los monocromos — un boleto blanco relleno con contorno
 * blanco sobre fondo oscuro seria invisible.
 */
const TONES = {
  color: { paper: "#f5eedd", ink: "#0d0d12", accent: "#4fe3ff" },
  ink: { paper: null, ink: "#000000", accent: "#000000" },
  white: { paper: null, ink: "#ffffff", accent: "#ffffff" },
};

/**
 * SVG de la pieza ilustrada como cadena.
 *
 * @param {object}  opts
 * @param {string}  opts.idp   Prefijo de ids, para incrustar varias copias.
 * @param {number}  opts.size  Tamano del lienzo (px).
 * @param {"color"|"ink"|"white"} opts.tone  Tinta.
 * @param {boolean} opts.detail  Serial, sello y chispas. Se cae por debajo de
 *   40px: medido, a 32px el sello (r=4) y el serial (1.5 de alto) quedan por
 *   debajo del pixel y solo ensucian. El boleto, su desgarro y su hachurado no
 *   cambian — el hachurado es lo que sostiene el dibujo a tamano chico.
 */
export function flashSvg({ idp = "fl", size = 512, tone = "color", detail = size >= 40 } = {}) {
  const { paper, ink, accent } = TONES[tone] ?? TONES.color;
  const cuts =
    `<path d="M${V.x0} ${V.y0} L${V.ax} ${V.ay} L${V.x1} ${V.y1}" fill="none" stroke="#000" stroke-width="${CUT}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="${T.x}" cy="31.5" r="3" fill="#000"/>` +
    `<circle cx="${T.x + T.w}" cy="31.5" r="3" fill="#000" />` +
    (detail
      ? [
          [11, 16.4, 17, 1.5],
          [11, 19.6, 12, 1.4],
          [11, 22.8, 17, 1.5],
          [36, 16.4, 17, 1.5],
          [41, 19.6, 12, 1.4],
          [36, 22.8, 17, 1.5],
        ]
          .map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="0.75" fill="#000"/>`)
          .join("")
      : "");
  const talon = `M${V.ax} ${V.ay} L${V.x1} ${V.y1} V${T.y + T.h} H${T.x} V${V.y0} Z`;
  const rect = `x="${T.x}" y="${T.y}" width="${T.w}" height="${T.h}" rx="${T.r}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="V-Pass">
  <defs>
    <mask id="${idp}-c" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
      <rect width="64" height="64" fill="#fff"/>
      <g fill="#000">${cuts}</g>
    </mask>
    <clipPath id="${idp}-t"><path d="${talon}"/></clipPath>
  </defs>
  ${
    paper
      ? `<rect ${rect} fill="${paper}" mask="url(#${idp}-c)"/>
  <g clip-path="url(#${idp}-t)" mask="url(#${idp}-c)">
    ${hatch(5.5, 44, 20, 53, -58, 1.15, 6, ink)}
    ${hatch(44, 44, 58.5, 53, 58, 1.15, 6, ink)}
    ${hatch(20, 50, 44, 56, 4, 1.3, 5, ink)}
  </g>`
      : `<g clip-path="url(#${idp}-t)" mask="url(#${idp}-c)">
    ${hatch(5.5, 44, 20, 53, -58, 1.15, 6, ink)}
    ${hatch(44, 44, 58.5, 53, 58, 1.15, 6, ink)}
    ${hatch(20, 50, 44, 56, 4, 1.3, 5, ink)}
  </g>`
  }
  <rect ${rect} fill="none" stroke="${ink}" stroke-width="2.5" mask="url(#${idp}-c)"/>
  <path d="${tornEdge([V.x0, V.y0], [V.ax, V.ay], 8)}" fill="none" stroke="${ink}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${tornEdge([V.ax, V.ay], [V.x1, V.y1], 8)}" fill="none" stroke="${ink}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  ${detail ? sparks(ink) : ""}
  ${
    detail
      ? `<circle cx="51.5" cy="41" r="4" fill="none" stroke="${ink}" stroke-width="1.4"/>
  <path d="M48.6 39.2 L51.5 42.8 L54.4 39.2" fill="none" stroke="${ink}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="51.5" cy="41" r="6.2" fill="none" stroke="${ink}" stroke-width="0.65" opacity="0.45"/>
  <circle cx="12.6" cy="16.5" r="1.15" fill="${accent}"/>`
      : ""
  }
</svg>`;
}
