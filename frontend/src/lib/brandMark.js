/**
 * Geometria del isotipo V-Pass.
 *
 * Un solo lugar define la forma; la consumen dos consumidores que no comparten
 * runtime: el componente React (src/components/Brand.jsx), el generador de
 * iconos PWA (build-icons.mjs) y el del kit de logotipo (build-logo-kit.mjs).
 *
 * LA IDEA: el troquel calado. El isotipo es un boleto, y su linea de
 * perforacion —la que separa el talon— no es recta: es una V. Y la V no esta
 * pintada encima del boleto: es un CANAL VACIO que lo atraviesa. El desgarro no
 * es un color, es un corte.
 *
 * POR QUE CALADO Y NO TRAZO: porque asi funciona en UNA SOLA TINTA. Un trazo
 * necesita un color distinto del fondo para verse; un corte no — el corte ES el
 * fondo, y el fondo siempre existe. Con la V como trazo, la version de una tinta
 * desaparecia (trazo y papel caian al mismo negro). Con la V calada, la version
 * de una tinta es un boleto negro con una V blanca. La restriccion la resuelve
 * la construccion, no una version degradada.
 *
 * POR QUE `currentColor` Y NO PAPEL CREMA. La version anterior rellenaba el
 * boleto de crema. Medido: crema sobre el canvas oscuro de la app da 17:1 de
 * contraste, pero crema sobre BLANCO da 1.16:1 — el isotipo desaparecia en
 * papelería, imprenta y cualquier fondo claro (el minimo para un grafico es 3:1,
 * WCAG 1.4.11). Ahora el boleto se pinta con `currentColor`: hereda la tinta del
 * contexto, asi que es oscuro sobre claro y claro sobre oscuro, sin variante que
 * mantener ni fondo que se le resista. El talon lleva el acento de marca, que es
 * el unico color propio del isotipo.
 *
 * De donde sale: del objeto central del producto. El boleto de la app (.tkt en
 * aesthetic-refresh.css) perfora su borde con muescas semicirculares. El isotipo
 * usa esa misma muesca en los bordes laterales, y el troquel convertido en V.
 */

/** Lienzo cuadrado del isotipo. */
export const VIEWBOX = "0 0 64 64";

/** El boleto: rectangulo de esquinas redondeadas, alto 42 / ancho 56. */
export const TICKET = { x: 4, y: 11, w: 56, h: 42, r: 7 };

/**
 * Muescas del pase: dos semicirculos mordidos en los bordes laterales.
 *
 * Salen del boleto real de la app. Centradas en el borde: el circulo queda mitad
 * dentro, mitad fuera, y el recorte es media luna. Van caladas (se ve el fondo).
 */
export const NOTCH = { r: 3.1, cy: 32 };

/**
 * El troquel: la V. Tres puntos — dos bocas en las muescas y el vertice abajo.
 *
 * Las bocas caen EXACTAMENTE sobre el centro de cada muesca (x=4 y x=60, y=32),
 * asi que el canal arranca donde el borde ya esta cortado: la lectura es "el
 * boleto se rasga de muesca a muesca", no "hay una V dibujada". El canal queda
 * algo mas corto que el boleto para no desbordar las esquinas redondeadas.
 */
export const TEAR = { x0: 11, y0: 32, apexX: 32, apexY: 44, x1: 53, y1: 32 };

/** Ancho del canal. Es el grosor del desgarro, no el de un trazo decorativo. */
export const TEAR_WIDTH = 5.4;

/**
 * Por debajo de este tamano se caen los cortes finos (serial y perforacion).
 *
 * Medido, no elegido: a 16px la perforacion (r=0.9) cae por debajo del pixel y
 * los puntos se funden en una linea gris que ensucia el canal; las lineas de
 * serial (1.5 de alto) quedan a medio pixel. El boleto, su V calada y sus
 * muescas no cambian: lo unico que se simplifica es el detalle impreso.
 */
export const SIMPLE_BELOW = 20;

/** Acento de marca: la tinta del talon, el unico color propio del isotipo. */
export const MARK_ACCENT = "#3d5cd6";

/**
 * Destello de marca: estrella de cuatro puntas simetrica.
 *
 * Ya no forma parte del isotipo —el isotipo es el boleto— pero sigue siendo la
 * marca grafica de la app: bullet de listas, indicador de carga y centro del QR.
 */
export const SPARK = { cx: 51, cy: 12, r: 4.4, waist: 0.32 };

/** Path de la estrella de cuatro puntas (el "sparkle" de la marca). */
export function sparkPath({ cx, cy, r, waist }) {
  const i = r * waist;
  return (
    `M${cx} ${cy - r} L${cx + i} ${cy - i} L${cx + r} ${cy} ` +
    `L${cx + i} ${cy + i} L${cx} ${cy + r} L${cx - i} ${cy + i} ` +
    `L${cx - r} ${cy} L${cx - i} ${cy - i} Z`
  );
}

/**
 * Los cortes del boleto, como DATOS.
 *
 * Se exportan como datos y no como SVG para que los dos consumidores construyan
 * los mismos elementos sin duplicar la aritmetica: antes la geometria vivia dos
 * veces y se desincronizaba. Un corte = un agujero en el papel.
 */
export function markCuts() {
  const rows = [
    { y: 16.6, w: 18 },
    { y: 19.9, w: 13 },
    { y: 23.2, w: 18 },
  ];
  const serial = rows.flatMap(({ y, w }) => [
    { x: 11, y, w, h: 1.5 },
    { x: 53 - w, y, w, h: 1.5 },
  ]);

  // Perforacion: puntos a los dos lados del canal, a lo largo de los brazos.
  const arms = [
    { a: [TEAR.x0, TEAR.y0], b: [TEAR.apexX, TEAR.apexY] },
    { a: [TEAR.apexX, TEAR.apexY], b: [TEAR.x1, TEAR.y1] },
  ];
  const dots = arms.flatMap(({ a, b }) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const nx = -dy / len;
    const ny = dx / len;
    const off = TEAR_WIDTH / 2 + 1.1;
    return [0.14, 0.38, 0.62, 0.86].flatMap((t) => {
      const px = a[0] + dx * t;
      const py = a[1] + dy * t;
      return [
        { cx: px + nx * off, cy: py + ny * off },
        { cx: px - nx * off, cy: py - ny * off },
      ];
    });
  });

  return { serial, dots };
}

/** Las muescas y el canal, como recorte sobre el boleto. */
function cutouts({ withDetail }) {
  const { r, cy } = NOTCH;
  const notch =
    `<circle cx="${TICKET.x}" cy="${cy}" r="${r}"/>` +
    `<circle cx="${TICKET.x + TICKET.w}" cy="${cy}" r="${r}"/>`;
  const tear =
    `<path d="M${TEAR.x0} ${TEAR.y0} L${TEAR.apexX} ${TEAR.apexY} ` +
    `L${TEAR.x1} ${TEAR.y1}" fill="none" stroke-width="${TEAR_WIDTH}" ` +
    `stroke-linecap="round" stroke-linejoin="round"/>`;
  if (!withDetail) return notch + tear;
  const { serial, dots } = markCuts();
  return (
    notch +
    tear +
    serial.map((s) => `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="0.75"/>`).join("") +
    dots.map((d) => `<circle cx="${d.cx.toFixed(2)}" cy="${d.cy.toFixed(2)}" r="0.9"/>`).join("")
  );
}

/** El talon: la parte que el desgarro separa, bajo el canal. */
const TALON_CLIP =
  `M${TEAR.x0} ${TEAR.y0} L${TEAR.apexX} ${TEAR.apexY} L${TEAR.x1} ${TEAR.y1} ` +
  `V${TICKET.y + TICKET.h} H${TICKET.x} V${TEAR.y0} Z`;

/**
 * SVG del isotipo como cadena, para el generador de iconos PWA y el kit.
 *
 * `ink` es la tinta del boleto. Por defecto `currentColor`: el isotipo hereda el
 * color del texto, asi que funciona sobre cualquier fondo sin variante aparte.
 * Los rasterizados (iconos, og-cover) pasan un color explicito, porque fuera del
 * DOM `currentColor` no resuelve y caeria a negro.
 *
 * `mono` colapsa el isotipo a UNA tinta: el talon pierde el acento y se
 * diferencia por tono (55%). Es lo que necesitan la imprenta, el bordado y el
 * fax, que no reproducen un segundo color.
 */
export function markSvg({
  idp = "vp",
  size = 512,
  ink = "currentColor",
  accent = MARK_ACCENT,
  mono = false,
} = {}) {
  const ticket = `x="${TICKET.x}" y="${TICKET.y}" width="${TICKET.w}" height="${TICKET.h}" rx="${TICKET.r}"`;
  const cuts = cutouts({ withDetail: size >= SIMPLE_BELOW });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="${size}" height="${size}" role="img" aria-label="V-Pass">
  <defs>
    <mask id="${idp}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
      <rect width="64" height="64" fill="#fff"/>
      <g fill="#000">${cuts}</g>
    </mask>
    <clipPath id="${idp}-t"><path d="${TALON_CLIP}"/></clipPath>
  </defs>
  <rect ${ticket} fill="${ink}" mask="url(#${idp}-m)"/>
  <rect ${ticket} fill="${mono ? ink : accent}"${mono ? ' opacity="0.55"' : ""} clip-path="url(#${idp}-t)" mask="url(#${idp}-m)"/>
</svg>`;
}
