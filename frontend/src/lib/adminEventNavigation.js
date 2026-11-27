export const EVENT_NAVIGATION = [
  { id: "resumen", label: "Resumen", icon: "chart" },
  { id: "ventas", label: "Ventas", icon: "ticket" },
  { id: "equipo", label: "Equipo", icon: "users" },
  { id: "accesos", label: "Accesos", icon: "door" },
];
export const EVENT_TOOLS = [
  { id: "rentabilidad", label: "Rentabilidad" },
  { id: "operacion", label: "Operación" },
  { id: "acreditaciones", label: "Acreditaciones", icon: "shield" },
  { id: "sesiones", label: "Sesiones", icon: "calendar" },
];

const EVENT_SECTIONS = [...EVENT_NAVIGATION, ...EVENT_TOOLS];
export const EVENT_TABS = EVENT_SECTIONS.map(({ id }) => id);

/** Enlaces viejos del backstage -> sección nueva equivalente. */
const LEGACY_EVENT_TABS = {
  entradas: "ventas",
  boletas: "ventas",
  cupones: "ventas",
  lineup: "resumen",
  cupos: "equipo",
  noche: "equipo",
};

export function normalizeEventTab(tab) {
  if (EVENT_TABS.includes(tab)) return tab;
  return Object.hasOwn(LEGACY_EVENT_TABS, tab) ? LEGACY_EVENT_TABS[tab] : "resumen";
}

export function eventSectionLabel(tab) {
  return EVENT_SECTIONS.find(({ id }) => id === tab)?.label ?? "Resumen";
}
