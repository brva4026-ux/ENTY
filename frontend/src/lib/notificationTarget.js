/** Destino de una notificación dentro del rediseño de Administración.
 *
 * Los triggers guardan links con pestañas viejas (o solo `?event=`). Aquí se
 * traducen a las cuatro secciones del backstage o a Reportes/Organización.
 * El link original se respeta si apunta fuera del área admin.
 */
export function adminTarget(n) {
  const link = n?.link;
  const tabByKind = {
    door_anomaly: "accesos",
    door_open: "resumen",
    capacity_alert: "accesos",
    event_autoclosed: "resumen",
    event_reminder: "resumen",
    waitlist_offered: "resumen",
    payment_approved: "ventas",
    ticket_reissued: "ventas",
    ticket_refunded: "ventas",
  };
  const tab = tabByKind[n?.kind];
  if (!link) {
    if (n?.kind === "payout_created" || n?.kind === "payout_reviewed" || n?.kind === "payout_disputed")
      return "/admin/reportes?tab=ventas";
    if (n?.kind === "invitation_accepted")
      return "/admin/organizacion?tab=equipo";
    return "/admin";
  }
  // Los avisos de staff (promotor/puerta) no viven en Administración: se
  // respetan tal cual para no mandarlos a una ruta que su rol no puede abrir.
  if (!link.startsWith("/admin")) return link;

  const [path, qs = ""] = link.split("?");
  const params = new URLSearchParams(qs);
  const eventId = params.get("event");
  if (eventId) {
    params.set("tab", tab || "resumen");
    return `/admin?${params.toString()}`;
  }
  const legacyTab = params.get("tab");
  if (path === "/admin" && ["equipo", "invitaciones", "ajustes"].includes(legacyTab)) {
    return `/admin/organizacion?tab=${legacyTab}`;
  }
  if (path === "/admin" && ["puerta", "promotores"].includes(legacyTab)) {
    return "/admin/reportes?tab=resultados";
  }
  if (path === "/admin" && ["cobros", "liquidaciones"].includes(legacyTab)) {
    return "/admin/reportes?tab=ventas";
  }
  if (path === "/admin" || path === "/admin/negocio" || path === "/admin/metricas") {
    if (n?.kind === "invitation_accepted")
      return "/admin/organizacion?tab=equipo";
    if (n?.kind?.startsWith("payout_"))
      return "/admin/reportes?tab=ventas";
    // Un aviso sin evento (histórico) no puede inventar un backstage: cae en
    // la lista de Eventos, que es donde el admin recupera el contexto.
    return "/admin";
  }
  return link;
}
