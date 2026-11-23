import { useState } from "react";
import { eventZone, formatEventDate, formatEventTime } from "../lib/eventTime";

const CATEGORY_LABEL = {
  Música: "Música",
  Deportes: "Deportes",
  Teatro: "Teatro",
  Fiesta: "Fiesta",
  Comedia: "Comedia",
  "Arte y cultura": "Arte y cultura",
};

/** Portada de una noche: afiche real o una tapa de categoría. */
export default function EventCover({
  ev,
  className = "",
  showDate = true,
  showTime = true,
}) {
  const [bad, setBad] = useState("");
  const tz = eventZone(ev);
  const category = ev?.category || "Evento";
  const label = CATEGORY_LABEL[category] || category;
  const hasFlyer = ev?.flyer_url && ev.flyer_url !== bad;
  const date = ev?.starts_at ? new Date(ev.starts_at) : null;
  const day = date
    ? new Intl.DateTimeFormat("es-CO", { timeZone: tz, day: "numeric" }).format(date)
    : "";
  const month = date
    ? new Intl.DateTimeFormat("es-CO", { timeZone: tz, month: "short" })
        .format(date)
        .replace(".", "")
        .toUpperCase()
    : "";
  const time = formatEventTime(ev?.starts_at, tz);

  return (
    <div
      className={`admin-cover ${className}`}
      data-cat={category}
      aria-hidden="true"
    >
      {hasFlyer && (
        <img
          src={ev.flyer_url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBad(ev.flyer_url)}
        />
      )}
      <span className="admin-cover-kicker">{label}</span>
      {showDate && date && (
        <span className="admin-cover-date evx-datecal">
          <b>{day}</b>
          <span>{month}</span>
        </span>
      )}
      {showTime && time && (
        <span className="admin-cover-kicker">{time}</span>
      )}
    </div>
  );
}

/** Texto corto que identifica el tipo de evento en la tarjeta. */
export function eventHook(ev) {
  if (!ev) return "";
  const acts = (ev.lineup || []).map((act) => act?.name).filter(Boolean);
  if (ev.category === "Música" && acts.length) {
    const names = acts.slice(0, 3).join(" · ");
    return acts.length > 3 ? `${names} +${acts.length - 3}` : names;
  }
  if (ev.category === "Deportes" && acts.length >= 2) {
    return `${acts[0]} vs ${acts[1]}`;
  }
  if (ev.category === "Deportes") return ev.description || "Encuentro deportivo";
  return ev.description || "";
}

export function eventFullDate(ev) {
  if (!ev?.starts_at) return "Fecha por confirmar";
  return formatEventDate(ev.starts_at, eventZone(ev), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
