/**
 * Geometria del isotipo V-Pass.
 *
 * Un solo lugar define la forma; la consumen dos consumidores que no comparten
 * runtime: el componente React (src/components/Brand.jsx) y el generador de
 * iconos PWA (build-icons.mjs, Node + Chromium) y el del kit de logotipo
 * (build-logo-kit.mjs).
 *
 * LA IDEA: la V es la luz. La placa es el pase —con las mismas muescas
 * semicirculares que el boleto real de la app (.tkt en aesthetic-refresh.css)—
 * y la V es la luz que lo atraviesa, encendida de hielo a azul. El destello,
 * arriba a la derecha, es la fuente de esa luz: por eso es cian y la V azul.
 *
 * Lo que se quito, y por que: la version anterior sumaba cuatro luces sobre la
 * misma placa (resplandor de abertura, halo del destello, brillo cenital y
 * suelo). A 16px esas luces no se leian como profundidad sino como niebla, y
 * ademas competian con la V. El concepto es el mismo —la luz atraviesa la
 * V— pero ahora lo dice UN elemento, no cuatro. Menos es la marca.
 */

/** Lienzo cuadrado del isotipo. */
export const VIEWBOX = "0 0 64 64";

/** Placa de fondo: cuadrado de esquinas muy redondeadas (forma de app icon). */
export const BADGE = { x: 1.5, y: 1.5, w: 61, h: 61, r: 15 };

/**
 * Muescas del pase: dos semicirculos mordidos en los bordes laterales.
 *
 * Salen del boleto real de la app, que perfora su borde con
 * `radial-gradient(circle at 50% 0, transparent 0 var(--notch), ...)`. Aqui van
 * a los lados (no arriba/abajo) porque el isotipo es cuadrado y en los lados
 * leen como "pase" sin comerse la V. Centradas en el borde: el circulo queda
 * mitad dentro, mitad fuera, y el recorte es media luna.
 */
export const NOTCH = { r: 5.2, cy: 32 };

/**
 * La V: el trazo de luz. Dos brazos al vertice central, puntas redondas.
 *
 * bbox del trazo: x 13.25..50.75, y 11.25..46.25 — margen parejo dentro de la
 * placa (util: 2.5..61.5) y sitio para el destello arriba a la derecha.
 */
export const V_PATH = "M18.5 16.5 L32 41 L45.5 16.5";
export const V_WIDTH = 10.5;

/**
 * Destello de marca: estrella de cuatro puntas simetrica. Es la FUENTE de la
 * luz del isotipo, asi que va en cian, el color mas calido de la paleta fria.
 *
 * Flota fuera del trazo de la V y entra entero en la placa respetando la
 * esquina redondeada (10 al centro del arco + 4.4 de radio = 14.4 <= 15).
 */
export const SPARK = { cx: 51, cy: 12, r: 4.4, waist: 0.32 };

/**
 * Por debajo de este tamano el isotipo se dibuja SOLO con la V.
 *
 * Medido, no elegido: a 16px el destello (r=4.4) toca la punta del brazo
 * derecho de la V y los dos se funden en una mancha; el halo lo empeora. La V
 * sola, en cambio, lee limpia a 16px — dos brazos y un vertice, sin ruido. A
 * partir de 24px hay pixeles de sobra y el destello aporta en vez de estorbar.
 * La marca no pierde identidad: sigue siendo la V luminosa sobre el pase.
 */
export const SIMPLE_BELOW = 24;

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
  badgeTop: "#1c2133",
  badgeBottom: "#0a0d16",
  badgeRing: "#5b8cff",
  vTop: "#eaf6ff",
  vMid: "#8bbcff",
  vBottom: "#3b5fe0",
  spark: "#4fe3ff",
};

/** Las dos muescas del pase, como recorte sobre la placa. */
function notchCuts(fill = "#000") {
  const { r, cy } = NOTCH;
  return (
    `<circle cx="${BADGE.x}" cy="${cy}" r="${r}" fill="${fill}"/>` +
    `<circle cx="${BADGE.x + BADGE.w}" cy="${cy}" r="${r}" fill="${fill}"/>`
  );
}

/**
 * SVG del isotipo como cadena, para el generador de iconos PWA y el kit.
 * `idp` prefija los ids de gradiente para poder incrustar varias copias.
 *
 * Capas, de atras hacia adelante: placa de carbon recortada por las muescas,
 * aro de filo, la V (degradado de luz) y el destello. El aro tambien va
 * recortado para que no repase las muescas.
 */
export function markSvg({ idp = "vp", size = 512 } = {}) {
  const { badgeTop, badgeBottom, badgeRing, vTop, vMid, vBottom, spark } = MARK_COLORS;
  const badge = `x="${BADGE.x}" y="${BADGE.y}" width="${BADGE.w}" height="${BADGE.h}" rx="${BADGE.r}"`;
  const vPath = `d="${V_PATH}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="${idp}-badge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${badgeTop}"/>
      <stop offset="1" stop-color="${badgeBottom}"/>
    </linearGradient>
    <linearGradient id="${idp}-v" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="${vTop}"/>
      <stop offset="0.4" stop-color="${vMid}"/>
      <stop offset="1" stop-color="${vBottom}"/>
    </linearGradient>
    <mask id="${idp}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
      <rect width="64" height="64" fill="#fff"/>
      ${notchCuts()}
    </mask>
  </defs>
  <rect ${badge} fill="url(#${idp}-badge)" mask="url(#${idp}-m)"/>
  <rect ${badge} fill="none" stroke="${badgeRing}" stroke-opacity="0.5" stroke-width="1.6" mask="url(#${idp}-m)"/>
  <path ${vPath} stroke="url(#${idp}-v)" stroke-width="${V_WIDTH}"/>
  <path d="${sparkPath(SPARK)}" fill="${spark}"/>
</svg>`;
}
