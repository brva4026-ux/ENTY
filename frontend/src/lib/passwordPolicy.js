/**
 * Política de contraseñas compartida con el backend
 * (backend/app/core/password_policy.py). Una sola fuente de verdad: si el
 * backend endurece la política, la UI la anuncia sin tocar nada más.
 *
 * Los requisitos se pintan como checklist en vivo (cada ítem ✓/✗ mientras
 * escribe) — el usuario no adivina por qué el botón está deshabilitado.
 */
export const REQUIREMENTS = [
  { key: "length", label: "Mínimo 8 caracteres", test: (pw) => (pw || "").length >= 8 },
  { key: "upper", label: "Una mayúscula", test: (pw) => /[A-ZÁÉÍÓÚÑ]/.test(pw || "") },
  { key: "lower", label: "Una minúscula", test: (pw) => /[a-záéíóúñ]/.test(pw || "") },
  { key: "digit", label: "Un número", test: (pw) => /[0-9]/.test(pw || "") },
];

/** Requisitos que NO cumple la contraseña, en orden estable. */
export function missingRequirements(pw) {
  return REQUIREMENTS.filter((r) => !r.test(pw));
}

/** ¿Cumple la política completa? (igual criterio que el 422 del backend) */
export function isValid(pw) {
  return missingRequirements(pw).length === 0;
}

/** Etiquetas de lo que falta: para mensajes "Le falta: ...". */
export function missingList(pw) {
  return missingRequirements(pw).map((r) => r.label);
}

/** Checklist lista para renderizar: {label, ok} por requisito. */
export function checklist(pw) {
  return REQUIREMENTS.map((r) => ({ label: r.label, ok: r.test(pw) }));
}
