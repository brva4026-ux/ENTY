/**
 * Envío por WhatsApp: un solo lugar para el formato que exige wa.me.
 *
 * Tres reglas del dominio:
 * 1. wa.me quiere el teléfono SOLO con dígitos, código de país incluido
 *    (Colombia = 57). Si viene corto o vacío, no se fabrica un chat
 *    equivocado: se devuelve null y la UI abre el selector de contactos.
 * 2. El texto va SIEMPRE encodeURIComponent: los saltos de linea del mensaje
 *    son parte del mensaje, no de la URL.
 * 3. El enlace que se comparte es la página pública de la boleta
 *    (`/t#<token>`), no el token crudo: el invitado abre ahí su QR.
 */

/** Dígitos válidos para wa.me: 10+ (con pais incluido). */
function waDigits(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d : "";
}

/** URL de wa.me o null si el telefono no sirve para abrir un chat seguro. */
export function waLink(phone, text) {
  const d = waDigits(phone);
  if (!d) return null;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

/**
 * Mensaje de BOLETA emitida: lo que el invitado necesita y nada más.
 * `eventName` cae a string vacia en silencio (boletas sin evento visible).
 */
export function ticketWaMessage({ customerName, eventName, ticketId, url }) {
  return [
    "🎟️ Tu boleta está lista",
    eventName ? `Evento: ${eventName}` : null,
    customerName ? `Nombre: ${customerName}` : null,
    ticketId ? `Boleta #${ticketId}` : null,
    "",
    `Ábrela y guárdala aquí (el QR para entrar): ${url}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Mensaje de COBRO pendiente (enlace de pago Wompi). Tono distinto: aquí
 * todavía NO hay boleta, hay un enlace para pagar.
 */
export function paymentWaMessage({ customerName, amountLabel, url }) {
  return `Hola ${customerName}! Te comparto el enlace para pagar tu boleta (${amountLabel}): ${url}`;
}
