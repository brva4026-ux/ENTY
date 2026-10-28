/**
 * Geometria del isotipo V-Pass.
 *
 * Un solo lugar define la forma; la consumen dos consumidores que no comparten
 * runtime: el componente React (src/components/Brand.jsx) y el generador de
 * iconos PWA (build-icons.mjs, Node + Chromium) y el del kit de logotipo
 * (build-logo-kit.mjs).
 *
 * LA IDEA: el troquel. El isotipo es un boleto, y su linea de perforacion —la
 * que separa el talon— no es recta: es una V. La V no esta pegada encima del
 * boleto; ES el desgarro por el que se separa. Un boleto real no lleva la marca
 * dentro: la marca es como se rompe.
 *
 * De donde sale: del objeto central del producto. El boleto de la app (.tkt en
 * aesthetic-refresh.css) perfora su borde con muescas semicirculares
 * (`radial-gradient(circle at 50% 0, transparent 0 var(--notch), ...)`) y su
 * linea de troquel. El isotipo usa las dos cosas a escala de marca: muescas en
 * los bordes laterales, y el troquel convertido en V.
 *
 * Por que papel crema y no placa oscura: una placa oscura sobre el canvas oscuro
 * de la app es invisible a 16px —por eso la version anterior tenia que dibujarse
 * "solo con la V" por debajo de cierto tamano, y aun asi el isotipo se perdia—.
 * El papel crema se ve entero, con sus muescas y su V, a cualquier tamano.
 */

/** Lienzo cuadrado del isotipo. */
export const VIEWBOX = "0 0 64 64";

/** El boleto: rectangulo de esquinas redondeadas, alto 43 / ancho 58. */
export const TICKET = { x: 3, y: 10.5, w: 58, h: 43, r: 7.5 };

/**
 * Muescas del pase: dos semicirculos mordidos en los bordes laterales.
 *
 * Salen del boleto real de la app, que perfora su borde con
 * `radial-gradient(circle at 50% 0, transparent 0 var(--notch), ...)`. Aqui van
 * a los lados porque el isotipo es cuadrado y en los lados leen como "boleto"
 * sin comerse el desgarro. Centradas en el borde: el circulo queda mitad dentro,
 * mitad fuera, y el recorte es media luna.
 */
export const NOTCH = { r: 3.2, cy: 32 };

/**
 * La V: el troquel. Arranca en las dos muescas y baja al vertice central.
 *
 * Los extremos caen EXACTAMENTE sobre el centro de cada muesca (x=3 y x=61,
 * y=32), asi que el desgarro empieza donde el borde ya esta cortado: la lectura
 * es "el boleto se rasga de muesca a muesca", no "hay una V dibujada".
 */
export const V_PATH = "M3 32 L32 47 L61 32";

/** Grosor del desgarro: lo bastante ancho para leerse a 16px. */
export const V_WIDTH = 4.6;

/** Grosor de la perforacion punteada que corre por dentro del desgarro. */
export const PERF_WIDTH = 1.9;

/**
 * Por debajo de este tamano el troquel se dibuja macizo.
 *
 * Medido, no elegido: a 16px el paso de la perforacion cae por debajo de 1px y
 * los puntos se funden en una linea gris que ensucia el desgarro. El talon
 * tintado, por lo mismo, deja de leerse como talon y solo baja el contraste.
 * A partir de 20px hay pixeles de sobra y las dos cosas aportan. El boleto y su
 * V no cambian: lo unico que se simplifica es el detalle fino.
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
export function sparkPath({ cx, cy, r, waist = 0.3 }) {
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
export const MARK_COLORS = {
  paperTop: "#fdf9f0",
  paperBottom: "#efe4c9",
  edge: "#3d5cd6",
  vTop: "#7d9dff",
  vMid: "#3d5cd6",
  vBottom: "#1d2f6e",
  stub: "#3d5cd6",
  perf: "#22357f",
};

/** Las dos muescas del pase, como recorte sobre el boleto. */
function notchCuts(fill = "#000") {
  const { r, cy } = NOTCH;
  return (
    `<circle cx="${TICKET.x}" cy="${cy}" r="${r}" fill="${fill}"/>` +
    `<circle cx="${TICKET.x + TICKET.w}" cy="${cy}" r="${r}" fill="${fill}"/>`
  );
}

/**
 * SVG del isotipo como cadena, para el generador de iconos PWA y el kit.
 * `idp` prefija los ids de gradiente para poder incrustar varias copias.
 *
 * Capas, de atras hacia adelante: boleto de papel recortado por las muescas, el
 * talon tintado (la parte que el desgarro separa), el filo, el desgarro en V y
 * por ultimo la perforacion punteada que corre por dentro. El filo y el talon
 * van recortados por las mismas muescas para que no las repasen.
 */
export function markSvg({ idp = "vp", size = 512 } = {}) {
  const { paperTop, paperBottom, edge, vTop, vMid, vBottom, stub, perf } = MARK_COLORS;
  const ticket = `x="${TICKET.x}" y="${TICKET.y}" width="${TICKET.w}" height="${TICKET.h}" rx="${TICKET.r}"`;
  const vPath = `d="${V_PATH}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  const simple = size < SIMPLE_BELOW;
  const stubClip = `M32 47 L61 32 L61 ${TICKET.y + TICKET.h} L32 ${TICKET.y + TICKET.h} Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="${idp}-paper" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="${paperTop}"/>
      <stop offset="1" stop-color="${paperBottom}"/>
    </linearGradient>
    <linearGradient id="${idp}-v" x1="0.1" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="${vTop}"/>
      <stop offset="0.45" stop-color="${vMid}"/>
      <stop offset="1" stop-color="${vBottom}"/>
    </linearGradient>
    <mask id="${idp}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
      <rect width="64" height="64" fill="#fff"/>
      ${notchCuts()}
    </mask>
    <clipPath id="${idp}-stub"><path d="${stubClip}"/></clipPath>
  </defs>
  <rect ${ticket} fill="url(#${idp}-paper)" mask="url(#${idp}-m)"/>
  ${simple ? "" : `<rect ${ticket} fill="${stub}" fill-opacity="0.1" mask="url(#${idp}-m)" clip-path="url(#${idp}-stub)"/>`}
  <rect ${ticket} fill="none" stroke="${edge}" stroke-opacity="0.55" stroke-width="1.7" mask="url(#${idp}-m)"/>
  <path ${vPath} stroke="url(#${idp}-v)" stroke-width="${V_WIDTH}"/>
  ${simple ? "" : `<path ${vPath} stroke="${perf}" stroke-opacity="0.4" stroke-width="${PERF_WIDTH}" stroke-dasharray="3 2.6"/>`}
</svg>`;
}
