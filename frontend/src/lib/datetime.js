/**
 * Formato de fecha local para los formularios del panel.
 *
 * `<input type="datetime-local">` trabaja en la zona del navegador y sin
 * offset, así que un ISO con zona (lo que devuelve la API) hay que convertirlo
 * a mano. Estaba copiado en el asistente de evento y en la edición del
 * backstage; un solo dueño evita que uno de los dos derive.
 */

/** Dos dígitos con cero a la izquierda ("7" -> "07"). */
export function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Date -> valor de `<input type="datetime-local">` (hora LOCAL, sin zona). */
export function toLocalInput(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}
