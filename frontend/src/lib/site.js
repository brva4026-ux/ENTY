/**
 * Datos del sitio que aparecen en superficies públicas (legales, footer).
 * Un solo lugar para el nombre y los contactos: si cambian, no hay que
 * buscarlos por las páginas.
 */
export const SITE = {
  name: "Enty",
  // Un solo buzón mientras no haya dominio propio: `enty.app` no tiene DNS ni
  // MX, así que un soporte@enty.app rebotaba (el mismo error que ya se corrigió
  // en el reset de contraseña: nunca ofrecer un canal que no entrega).
  legalEmail: "vargasblancobrayan@gmail.com",
  supportEmail: "vargasblancobrayan@gmail.com",
  // WhatsApp de soporte: SOLO dígitos con código de país, que es el formato
  // que exige wa.me (lib/whatsapp.js). El de display va aparte para mostrarlo
  // legible sin que el enlace dependa de cómo lo escriba una persona.
  supportWhatsApp: "573102765347",
  supportPhone: "+57 310 276 5347",
};
