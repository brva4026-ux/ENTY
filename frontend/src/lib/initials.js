/**
 * Iniciales para avatares y tiles de identidad ("Bar Esquina" -> "BE").
 *
 * Vivía copiado en cuatro componentes con criterios distintos: tres tomaban la
 * primera letra de hasta dos palabras (un nombre de una sola palabra devolvía
 * UNA letra, y el tile se veía desbalanceado) y `VenueHeader` tomaba dos
 * caracteres cuando había una sola palabra. Un solo dueño evita que el mismo
 * negocio se vea "B" en una pantalla y "BA" en otra.
 *
 * Reglas: sin nombre -> "?"; una palabra -> sus dos primeras letras; dos o más
 * -> la inicial de las dos primeras. Siempre devuelve dos caracteres cuando hay
 * material, que es lo que exige el tile (portada-identidad.spec.js).
 */
export function initials(name) {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
