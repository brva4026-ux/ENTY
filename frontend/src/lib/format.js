/** Formatos compartidos: dinero en pesos colombianos y horas de puerta. */

const COP = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

/** Centavos -> "$ 30.000". La API trabaja en centavos; la UI en pesos. */
export function money(cents) {
  return COP.format(Math.round((cents ?? 0) / 100));
}

/** Hora corta "11:42 p.m." para el último escaneo. */
export function timeAgo(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  const secs = Math.floor((Date.now() - then.getTime()) / 1000);
  if (secs < 10) return "ahora";
  if (secs < 60) return `hace ${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  return then.toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}

export function clockTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Fecha del evento: "vie 20 sep · 9:00 p.m." */
export function eventDate(iso) {
  if (!iso) return "";
  // El endpoint público (/tickets/preview) manda la fecha YA FORMATEADA
  // ("29/09/2026 21:00"): new Date() sobre ese formato da Invalid Date y la
  // boleta del invitado mostraba el texto literal. Si no parsea como ISO,
  // se asume que ya viene listo para mostrar.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("es-CO", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const time = d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
}
