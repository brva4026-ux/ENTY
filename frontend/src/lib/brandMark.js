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
 * Nucleo luminoso del trazo: una pasada interior clara sobre el degradado.
 * Convierte la V de una forma plana en un tubo de neon. A 16px aporta filo
 * (medido: sube la proporcion de pixeles brillantes de 0.20 a 0.25 y baja el
 * emborronado de medios tonos), asi que no se omite en tamanos chicos.
 */
export const V_CORE_WIDTH = 3.2;

/**
 * Destello de marca: estrella de cuatro puntas simetrica.
 *
 * Flota fuera del trazo de la V (4px de aire hasta la punta redondeada del
 * brazo derecho) y entra entero en la placa respetando la esquina redondeada
 * (10 al centro del arco + 4.5 de radio = 14.5 <= 15). Antes medía r=7.5 y se
 * comía el brazo.
 */
export const SPARK = { cx: 55.5, cy: 10.5, r: 4.5, waist: 0.32 };

/** Radio del halo cian que se enciende detras del destello. */
export const SPARK_HALO = 8.5;

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
  badgeTop: "#181c2a",
  badgeBottom: "#0a0d16",
  badgeRing: "#5b8cff",
  sheen: "#ffffff",
  floor: "#000000",
  vTop: "#a8c2ff",
  vMid: "#5b8cff",
  vBottom: "#4fe3ff",
  vCore: "#eaf4ff",
  spark: "#4fe3ff",
};

/**
 * SVG del isotipo como cadena, para el generador de iconos PWA.
 * `idp` prefija los ids de gradiente para poder incrustar varias copias.
 *
 * El dibujo va por capas, de atras hacia adelante: placa con degradado, brillo
 * cenital y suelo, aro de filo, halo del destello, la V (degradado + nucleo
 * claro) y por ultimo el destello. Todo entra por el mismo clipPath de la placa
 * para que el brillo no se salga de las esquinas redondeadas.
 */
export function markSvg({ idp = "vp", size = 512 } = {}) {
  const {
    badgeTop, badgeBottom, badgeRing, sheen, floor,
    vTop, vMid, vBottom, vCore, spark,
  } = MARK_COLORS;
  const badge = `x="${BADGE.x}" y="${BADGE.y}" width="${BADGE.w}" height="${BADGE.h}" rx="${BADGE.r}"`;
  const vPath = `d="${V_PATH}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="${idp}-badge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${badgeTop}"/>
      <stop offset="1" stop-color="${badgeBottom}"/>
    </linearGradient>
    <linearGradient id="${idp}-sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${sheen}" stop-opacity="0.16"/>
      <stop offset="0.55" stop-color="${sheen}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${idp}-v" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="${vTop}"/>
      <stop offset="0.55" stop-color="${vMid}"/>
      <stop offset="1" stop-color="${vBottom}"/>
    </linearGradient>
    <radialGradient id="${idp}-halo">
      <stop offset="0" stop-color="${spark}" stop-opacity="0.7"/>
      <stop offset="1" stop-color="${spark}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="${idp}-clip"><rect ${badge}/></clipPath>
  </defs>
  <rect ${badge} fill="url(#${idp}-badge)"/>
  <g clip-path="url(#${idp}-clip)">
    <rect ${badge} fill="url(#${idp}-sheen)"/>
    <rect x="${BADGE.x}" y="45" width="${BADGE.w}" height="17.5" fill="${floor}" opacity="0.3"/>
  </g>
  <rect ${badge} fill="none" stroke="${badgeRing}" stroke-opacity="0.5" stroke-width="1.6"/>
  <circle cx="${SPARK.cx}" cy="${SPARK.cy}" r="${SPARK_HALO}" fill="url(#${idp}-halo)"/>
  <path ${vPath} stroke="url(#${idp}-v)" stroke-width="${V_WIDTH}"/>
  <path ${vPath} stroke="${vCore}" stroke-opacity="0.4" stroke-width="${V_CORE_WIDTH}"/>
  <path d="${sparkPath(SPARK)}" fill="${spark}"/>
</svg>`;
}
