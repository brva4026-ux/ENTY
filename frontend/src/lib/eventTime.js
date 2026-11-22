/**
 * Fechas de evento en SU zona horaria.
 *
 * `starts_at`/`ends_at` viajan como instantes ISO. Mostrarlos con la zona del
 * navegador hacía que una noche del 30 de septiembre a las 23:00 en Bogotá
 * apareciera como 1 de octubre en un equipo en UTC: el evento existía, pero la
 * tarjeta lo mandaba al mes equivocado. La zona del evento es la que manda en
 * la lista, la ficha y el editor.
 */

export const DEFAULT_EVENT_TZ = "America/Bogota";

export function eventZone(ev) {
  return ev?.event_timezone || ev?.timezone || DEFAULT_EVENT_TZ;
}

function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const out = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

function zoneOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** ISO -> valor de `<input type="datetime-local">` en la zona del evento. */
export function toZonedInput(value, timeZone = DEFAULT_EVENT_TZ) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const p = zonedParts(d, timeZone);
  return (
    `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}` +
    `T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`
  );
}

/** Valor de `<input type="datetime-local">` en la zona del evento -> ISO. */
export function fromZonedInput(value, timeZone = DEFAULT_EVENT_TZ) {
  const m = String(value || "").match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/,
  );
  if (!m) return null;
  const [, y, mo, d, h, min] = m.map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, min);
  // Dos pasadas cubren los cambios de horario de verano: la primera estima el
  // offset con el reloj UTC, la segunda lo corrige con la hora ya convertida.
  let offset = zoneOffsetMs(new Date(guess), timeZone);
  let ts = guess - offset;
  offset = zoneOffsetMs(new Date(ts), timeZone);
  ts = guess - offset;
  const out = new Date(ts);
  return Number.isNaN(out.getTime()) ? null : out.toISOString();
}

export function formatEventDate(
  value,
  timeZone = DEFAULT_EVENT_TZ,
  opts = {},
) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-CO", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    ...opts,
  }).format(d);
}

export function formatEventTime(value, timeZone = DEFAULT_EVENT_TZ) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("es-CO", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** ¿La noche ya terminó? `ends_at` manda; sin él se da 12 h de margen. */
export function isPastEvent(ev, now = Date.now()) {
  if (!ev) return false;
  const end = ev.ends_at
    ? new Date(ev.ends_at).getTime()
    : new Date(ev.starts_at).getTime() + 12 * 3600_000;
  return Number.isFinite(end) && end < now;
}

/** "Evento pasado" solo es una alerta si la puerta sigue abierta. */
export function isStaleLive(ev, now = Date.now()) {
  return ev?.status === "live" && isPastEvent(ev, now);
}
