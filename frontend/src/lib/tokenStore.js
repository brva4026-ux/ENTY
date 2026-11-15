/**
 * Dueño único del token de sesión. El login ofrece "Recordarme": marcado, el
 * token vive en localStorage y sobrevive al cierre del navegador; sin marcar,
 * en sessionStorage y muere con la pestaña (lo que pide el modo compartido de
 * la puerta, ver docs/arquitectura/03-seguridad.md). El JWT es el mismo en los
 * dos casos: solo cambia dónde se guarda.
 *
 * Antes cada consumidor leía/escribía localStorage a mano, así que la casilla
 * no cambiaba nada: el token quedaba persistente siempre. Centralizar evita que
 * un sitio olvide mirar los dos almacenes (y trate una sesión viva como si no
 * hubiera token).
 */
const KEY = "tf_token";

export function getToken() {
  return localStorage.getItem(KEY) ?? sessionStorage.getItem(KEY);
}

export function setToken(token, { remember = true } = {}) {
  const keep = remember ? localStorage : sessionStorage;
  const drop = remember ? sessionStorage : localStorage;
  keep.setItem(KEY, token);
  drop.removeItem(KEY);
}

export function clearToken() {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(KEY);
}

/** ¿La sesión actual se guardó para sobrevivir al cierre del navegador? */
export function isRemembered() {
  return localStorage.getItem(KEY) !== null;
}
