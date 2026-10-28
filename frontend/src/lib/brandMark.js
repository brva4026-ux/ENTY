/**
 * Geometria del isotipo V-Pass.
 *
 * Un solo lugar define la forma; la consumen dos consumidores que no comparten
 * runtime: el componente React (src/components/Brand.jsx) y el generador de
 * iconos PWA (build-icons.mjs, Node + Chromium) y el del kit de logotipo
 * (build-logo-kit.mjs).
 *
 * LA IDEA: el troquel calado. El isotipo es un boleto, y su linea de
 * perforacion —la que separa el talon— no es recta: es una V. Y la V no esta
 * pintada encima del boleto: es un CANAL VACIO que lo atraviesa. El desgarro no
 * es un color, es un corte.
 *
 * Por que calado y no trazo: porque asi funciona en UNA SOLA TINTA. Un trazo
 * necesita un color distinto del fondo para verse; un corte no — el corte ES el
 * fondo, y el fondo siempre existe. Se probo: con la V como trazo, la version de
 * una tinta desaparecia (trazo y papel caian al mismo negro). Con la V calada,
 * la version de una tinta es un boleto negro con una V blanca. No hay parche ni
 * version degradada: la restriccion la resuelve la construccion.
 *
 * De donde sale: del objeto central del producto. El boleto de la app (.tkt en
 * aesthetic-refresh.css) perfora su borde con muescas semicirculares
 * (`radial-gradient(circle at 50% 0, transparent 0 var(--notch), ...)`). El
 * isotipo usa esa misma muesca en los bordes laterales, y el troquel convertido
 * en V.
 *
 * Por que papel crema: una placa oscura sobre el canvas oscuro de la app es
 * invisible a 16px. El papel crema se ve entero, con sus muescas y su V, a
 * cualquier tamano. Sobre fondos claros el isotipo pide su version invertida
 * (papel azul, talon crema), como cualquier marca.
 */

/** Lienzo cuadrado del isotipo. */
export const VIEWBOX = "0 0 64 64";

/** El boleto: rectangulo de esquinas redondeadas, alto 42 / ancho 56. */
export const TICKET = { x: 4, y: 11, w: 56, h: 42, r: 7 };

/**
 * Muescas del pase: dos semicirculos mordidos en los bordes laterales.
 *
 * Salen del boleto real de la app. Centradas en el borde: el circulo queda mitad
 * dentro, mitad fuera, y el recorte es media luna. Aqui van caladas (se ve el
 * fondo), no pintadas.
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
 * serial (1.5 de alto) quedan a medio pixel. El boleto, su V calada, sus muescas
 * y su talon no cambian: lo unico que se simplifica es el detalle impreso.
 */
export const SIMPLE_BELOW = 20;

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
 * Colores del isotipo para el rasterizado (Node no lee var(--e-*)).
 * En el componente React los mismos pasos se consumen como tokens CSS, asi
 * que la marca del icono y la de la app son la misma.
 */
const MARK_COLORS = {
  paperTop: "#fdf9f0",
  paperBottom: "#efe4c9",
  edge: "#3d5cd6",
  talon: "#3d5cd6",
};

/**
 * Los cortes del boleto, como DATOS.
 *
 * Se exportan como datos y no como SVG para que los dos consumidores construyan
 * los mismos elementos sin duplicar la aritmetica: antes la geometria vivia dos
 * veces y se desincronizaba (ver AGENTS.md). Un corte = un agujero en el papel.
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
 * `idp` prefija los ids de gradiente para poder incrustar varias copias.
 *
 * Capas, de atras hacia adelante: el boleto de papel recortado por los cortes
 * (muescas, canal, serial, perforacion), el talon en el color de marca —tambien
 * recortado, para que el canal quede vacio de lado a lado— y el filo.
 */
export function markSvg({ idp = "vp", size = 512 } = {}) {
  const { paperTop, paperBottom, edge, talon } = MARK_COLORS;
  const ticket = `x="${TICKET.x}" y="${TICKET.y}" width="${TICKET.w}" height="${TICKET.h}" rx="${TICKET.r}"`;
  const cuts = cutouts({ withDetail: size >= SIMPLE_BELOW });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="${idp}-paper" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0" stop-color="${paperTop}"/>
      <stop offset="1" stop-color="${paperBottom}"/>
    </linearGradient>
    <mask id="${idp}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
      <rect width="64" height="64" fill="#fff"/>
      <g fill="#000">${cuts}</g>
    </mask>
    <clipPath id="${idp}-talon"><path d="${TALON_CLIP}"/></clipPath>
  </defs>
  <rect ${ticket} fill="url(#${idp}-paper)" mask="url(#${idp}-m)"/>
  <rect ${ticket} fill="${talon}" clip-path="url(#${idp}-talon)" mask="url(#${idp}-m)"/>
  <rect ${ticket} fill="none" stroke="${edge}" stroke-opacity="0.45" stroke-width="1.5" mask="url(#${idp}-m)"/>
</svg>`;
}
