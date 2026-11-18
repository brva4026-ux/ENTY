/**
 * Dueño único de la credencial heredada `tf_token` en el navegador.
 *
 * La sesión web vive en una cookie HttpOnly (`tf_session`): JavaScript no la
 * lee ni la escribe. `tf_token` solo sobrevive para el camino heredado (una
 * pestaña abierta antes del cambio de cookie, o el respaldo Bearer de clientes
 * viejos), y `/auth/me` lo borra en cuanto migra la sesión a la cookie.
 *
 * Esa credencial NUNCA vive en `localStorage`: un token de sesión en
 * `localStorage` sobrevive al cierre del navegador y lo puede leer cualquier
 * script del origen (es el primer objetivo de un XSS). Se guarda en
 * `sessionStorage` —muere con la pestaña— y `clearToken` limpia ambos sitios
 * para no dejar residuos de versiones anteriores que usaban `localStorage`.
 *
 * Centralizar la lectura evita que cada consumidor toque el storage a mano y
 * que alguno mire una clave distinta de la que se limpia.
 */
const KEY = "tf_token";

export function getToken() {
  try {
    return sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearToken() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* storage bloqueado (modo privado): no hay nada que limpiar */
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* idem */
  }
}
