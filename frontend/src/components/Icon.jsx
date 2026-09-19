/**
 * Set de iconos de linea. Todos comparten viewBox 24, trazo 1.75 y remates
 * redondeados: esa uniformidad es lo que hace que un set se vea dibujado por
 * la misma mano. Se heredan color y tamano por `currentColor` + `className`.
 *
 * Antes cada pantalla resolvia sus iconos a mano (`✓`, `✗`, un SVG suelto),
 * asi que el grosor del trazo cambiaba de una vista a otra.
 */
const PATHS = {
  ticket: "M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.4a2.6 2.6 0 0 0 0 5.2V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.4a2.6 2.6 0 0 0 0-5.2V8Zm7.4-2.3v12.6",
  door: "M5 20V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15M3.5 20h17M13 12h.01",
  calendar: "M7 3v3M17 3v3M4 8.5h16M6 4.5h12a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z",
  money: "M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-9Zm9 1.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  users: "M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM21 20v-1.5a4 4 0 0 0-3-3.87M16.5 3.75a4 4 0 0 1 0 7.5",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5.5-1.5L21 21",
  camera: "M3 8.5A1.5 1.5 0 0 1 4.5 7h1.9a1 1 0 0 0 .83-.45l.74-1.1A1 1 0 0 1 8.8 5h6.4a1 1 0 0 1 .83.45l.74 1.1A1 1 0 0 0 17.6 7h1.9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-9Zm9 7.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
  check: "M4.5 12.5 9.5 17.5 19.5 6.5",
  close: "M6 6l12 12M18 6 6 18",
  alert: "M12 8.5v4.5M12 16.5h.01M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  shield: "M12 3 4.5 6v6c0 4.4 3.2 7.8 7.5 9 4.3-1.2 7.5-4.6 7.5-9V6L12 3Zm-2.5 8.5 2 2 4-4",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  plus: "M12 5v14M5 12h14",
  logout: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h11",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3.5 2",
  bolt: "M13.5 3 5 13.5h5.5L10 21l8.5-10.5H13L13.5 3Z",
  qr: "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 3h2m2 0h1m-5 3h3m2-3v3",
  flag: "M5 21V4m0 1h11.5l-2 4 2 4H5",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  sparkle: "M12 3.5 13.9 9l5.6 2-5.6 2-1.9 5.5L10.1 13 4.5 11l5.6-2L12 3.5Z",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
};

const FILLED = {
  whatsapp:
    "M12.04 2a9.9 9.9 0 0 0-8.51 14.93L2 22l5.2-1.49A9.9 9.9 0 1 0 12.04 2zm5.77 14.06c-.24.68-1.4 1.3-1.93 1.35-.52.05-1.01.24-3.4-.71-2.87-1.13-4.68-4.06-4.82-4.25-.14-.19-1.15-1.53-1.15-2.92 0-1.39.73-2.07.99-2.35.26-.28.57-.35.76-.35h.55c.18 0 .42-.07.66.5.24.57.83 1.97.9 2.11.07.14.12.31.02.5-.09.19-.14.3-.28.47-.14.17-.3.38-.42.51-.14.14-.29.3-.12.58.16.28.73 1.2 1.57 1.95 1.08.96 1.99 1.26 2.27 1.4.28.14.44.12.6-.07.17-.19.7-.81.88-1.09.19-.28.38-.23.63-.14.26.09 1.63.77 1.91.91.28.14.47.21.54.33.07.12.07.68-.17 1.36z",
};

export default function Icon({ name, className = "h-5 w-5", strokeWidth = 1.75, ...rest }) {
  const filled = FILLED[name];
  const path = PATHS[name];
  if (!filled && !path) return null;

  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? undefined : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {filled ? <path d={filled} /> : <path d={path} />}
    </svg>
  );
}