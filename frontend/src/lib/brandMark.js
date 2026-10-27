/**
 * Geometria del isotipo V-Pass.
 *
 * Un solo lugar define la forma; la consumen dos consumidores que no comparten
 * runtime: el componente React (src/components/Brand.jsx) y el generador de
 * iconos PWA (build-icons.mjs, Node + Chromium). Antes cada uno llevaba su
 * copia del logo y se desincronizaban.
 *
 * El isotipo es la "V" de V-Pass: dos brazos que descienden a un vertice, el
 * corte de un pase de acceso, sobre una placa de carbon con el destello de la
 * marca arriba a la derecha. Vectorial: escala a 16px (favicon) y a 512px (app
 * icon) sin perder filo — el JPEG original se recortaba mal en el tile
 * cuadrado y pesaba 1.8 MB.
 */

/** Lienzo cuadrado del isotipo. */
export const VIEWBOX = "0 0 64 64";

/** Placa de fondo: cuadrado de esquinas muy redondeadas (forma de app icon). */
export const BADGE = { x: 1.5, y: 1.5, w: 61, h: 61, r: 15 };

/**
 * La "V": dos brazos al vertice central. Trazo grueso con puntas redondas.
 *
 * Geometria corregida. La version anterior tenia el vertice en y=44.5 y los
 * brazos en x=20.5/43.5, lo que dejaba el destello SOLAPADO 6.25px sobre el
 * brazo derecho (se veia como una mancha pegada a la V) y la V ocupaba solo
 * el 37% del ancho de la placa. Ahora:
 *   bbox del trazo: x 14..50, y 14..50  -> margen parejo de 12.5 en los 4 lados
 *   (placa util: 2.5..61.5)
 */
export const V_PATH = "M19 19 L32 45 L45 19";
export const V_WIDTH = 10;

/**
 * Destello de marca: estrella de cuatro puntas simetrica.
 *
 * Flota fuera del trazo de la V (4px de aire hasta la punta redondeada del
 * brazo derecho) y entra entero en la placa respetando la esquina redondeada
 * (10 al centro del arco + 4.5 de radio = 14.5 <= 15). Antes medía r=7.5 y se
 * comía el brazo.
 */
export const SPARK = { cx: 55.5, cy: 10.5, r: 4.5, waist: 0.32 };

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
  badgeTop: "#161a26",
  badgeBottom: "#080a12",
  badgeRing: "#5b8cff",
  vTop: "#7aa2ff",
  vBottom: "#4fe3ff",
  spark: "#4fe3ff",
};

/**
 * SVG del isotipo como cadena, para el generador de iconos PWA.
 * `idp` prefija los ids de gradiente para poder incrustar varias copias.
 */
export function markSvg({ idp = "vp", size = 512 } = {}) {
  const { badgeTop, badgeBottom, badgeRing, vTop, vBottom, spark } = MARK_COLORS;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="${idp}-badge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${badgeTop}"/>
      <stop offset="1" stop-color="${badgeBottom}"/>
    </linearGradient>
    <linearGradient id="${idp}-v" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${vTop}"/>
      <stop offset="1" stop-color="${vBottom}"/>
    </linearGradient>
  </defs>
  <rect x="${BADGE.x}" y="${BADGE.y}" width="${BADGE.w}" height="${BADGE.h}" rx="${BADGE.r}" fill="url(#${idp}-badge)"/>
  <rect x="${BADGE.x}" y="${BADGE.y}" width="${BADGE.w}" height="${BADGE.h}" rx="${BADGE.r}" fill="none" stroke="${badgeRing}" stroke-opacity="0.45" stroke-width="1.5"/>
  <path d="${V_PATH}" fill="none" stroke="url(#${idp}-v)" stroke-width="${V_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${sparkPath(SPARK)}" fill="${spark}"/>
</svg>`;
}
