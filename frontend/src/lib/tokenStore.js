/**
 * Dueño único de la credencial heredada `tf_token` en el navegador.
 *
 * La sesión web vive en una cookie HttpOnly (`tf_session`): JavaScript no la
 * lee ni la escribe, y `/auth/me` borra `tf_token` en cuanto migra una sesión
 * vieja a la cookie. Ese token en `localStorage` solo sobrevive para el camino
 * heredado (una pestaña abierta antes del cambio) y para el respaldo Bearer de
 * clientes que aún lo mandan.
 *
 * Centralizar la lectura evita que cada consumidor toque el storage a mano y
 * que alguno mire una clave distinta de la que se limpia.
 */
const KEY = "tf_token";

export function getToken() {
  return localStorage.getItem(KEY);
}

export function clearToken() {
  localStorage.removeItem(KEY);
}
