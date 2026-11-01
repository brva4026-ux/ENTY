/**
 * Mensajes de validación nativa en español.
 *
 * El navegador redacta sus avisos en SU idioma ("Please fill out this field."),
 * no en el de la página: `lang="es"` no los cambia. Traducirlos form por form
 * obligaba a quitar `required` y reimplementar la validación — y en varios
 * formularios ese atributo es la única barrera (el handler va directo a la API).
 *
 * Aquí se conserva la validación nativa (sigue bloqueando el envío) y solo se
 * sustituye el texto. `invalid` no burbujea: hay que escucharlo en captura.
 * Un mensaje de `setCustomValidity` deja el campo inválido para siempre, así que
 * se limpia en cuanto el usuario edita.
 */

const MENSAJES = {
  valueMissing: "Completa este campo.",
  patternMismatch: "Revisa el formato.",
  badInput: "Revisa este valor.",
  stepMismatch: "Usa un valor de la lista.",
  rangeUnderflow: "El valor es demasiado bajo.",
  rangeOverflow: "El valor es demasiado alto.",
};

function mensajeDe(el) {
  const v = el.validity;
  if (v.valueMissing) return MENSAJES.valueMissing;
  if (v.typeMismatch) {
    if (el.type === "email") return "Escribe un correo electrónico válido.";
    if (el.type === "url") return "Escribe una dirección web válida.";
    return MENSAJES.patternMismatch;
  }
  if (v.patternMismatch) return MENSAJES.patternMismatch;
  if (v.tooShort) {
    return `Usa al menos ${el.minLength} caracteres.`;
  }
  if (v.tooLong) {
    return `Usa como máximo ${el.maxLength} caracteres.`;
  }
  if (v.badInput) return MENSAJES.badInput;
  if (v.stepMismatch) return MENSAJES.stepMismatch;
  if (v.rangeUnderflow) return MENSAJES.rangeUnderflow;
  if (v.rangeOverflow) return MENSAJES.rangeOverflow;
  return "Revisa este campo.";
}

function esCampo(el) {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  );
}

document.addEventListener(
  "invalid",
  (e) => {
    if (!esCampo(e.target)) return;
    e.target.setCustomValidity(mensajeDe(e.target));
  },
  true,
);

// Sin esto el campo quedaría inválido para siempre y no dejaría reenviar.
for (const tipo of ["input", "change"]) {
  document.addEventListener(
    tipo,
    (e) => {
      if (esCampo(e.target)) e.target.setCustomValidity("");
    },
    true,
  );
}
