/**
 * Presupuesto de movimiento para clientes con poco margen.
 *
 * Una conexion lenta o el ahorro de datos no piden "menos animacion" por
 * gusto: piden no gastar CPU ni bytes en ella. El revelado, el parallax y las
 * cifras que cuentan son gratis en datos pero no en frames, y en un 2G el
 * scroll ya va justo.
 *
 * `navigator.connection` no existe en Safari ni en Firefox: su ausencia
 * significa "no lo se", y se trata como red normal (no se degrada a ciegas).
 */
import { prefersReducedMotion } from "./motion.js";

const SLOW = new Set(["slow-2g", "2g", "3g"]);

/** ¿La red es lenta o el usuario pidio ahorrar datos? */
export function slowConnection(
  nav = typeof navigator === "undefined" ? null : navigator,
) {
  const conn = nav?.connection;
  if (!conn) return false;
  if (conn.saveData === true) return true;
  return SLOW.has(conn.effectiveType);
}

/** ¿Se permite la capa de movimiento "rica" (revelado, parallax, cifras)? */
export function richMotion() {
  return !prefersReducedMotion() && !slowConnection();
}
