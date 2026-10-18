/**
 * Colores del QR.
 *
 * La libreria `qrcode` rasteriza a canvas: no entiende `var(--e-*)`, necesita
 * el hex literal. Por eso vive aqui y no en tokens.css, y por eso los cuatro
 * puntos que generan un QR importan estas constantes en vez de repetir el
 * color (antes cada pantalla traia su propio negro, todos distintos).
 *
 * Es tinta de escaner, no color de marca: negro calido sobre blanco puro da
 * el contraste maximo que exige una camara en la puerta.
 */
export const QR_COLORS = { dark: "#0c0a09", light: "#ffffff" };
