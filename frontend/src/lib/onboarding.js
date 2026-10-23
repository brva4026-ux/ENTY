/**
 * Preferencia de la guia de primeros pasos, por venue.
 *
 * Antes la clave era global (`tf_onboarding_done`) y la escribian dos sitios
 * distintos: el boton de descartar y —sin decirlo— el modal de crear evento.
 * Eso producia dos problemas:
 *
 * 1. La guia se apagaba en el paso 1 de 4. El admin nuevo creaba su evento y
 *    los pasos 2-4 (tipos, cupos, publicar) no se veian nunca mas.
 * 2. La clave no distinguia venue: un admin con dos negocios veia la guia en
 *    el primero y nunca en el segundo.
 *
 * Estados posibles (`tf_onboarding:<venue>`):
 *   ausente    -> no decidio todavia: se le OFRECE la guia (opt-in)
 *   "accepted" -> la quiere: se muestra y se oculta sola al completarla
 *   "dismissed"-> la rechazo o la cerro: no se muestra, pero queda el acceso
 *                 para volver a abrirla (nunca es irreversible)
 *
 * Solo hay UN escritor (este modulo): el modal de crear evento ya no toca la
 * preferencia, solo avanza el progreso, que es un hecho y no una decision.
 */
const PREFIX = "tf_onboarding";

/** Clave por venue: la decision de un negocio no afecta a otro. */
function keyFor(venueId) {
  return venueId ? `${PREFIX}:${venueId}` : PREFIX;
}

/** Estado guardado: "accepted" | "dismissed" | null (sin decidir). */
export function getOnboardingPreference(venueId) {
  try {
    const v = localStorage.getItem(keyFor(venueId));
    return v === "accepted" || v === "dismissed" ? v : null;
  } catch {
    return null;
  }
}

export function setOnboardingPreference(venueId, pref) {
  try {
    localStorage.setItem(keyFor(venueId), pref);
  } catch {
    /* sin storage: la eleccion dura la sesion */
  }
}

/**
 * Limpieza de la clave vieja (global, previa a este cambio).
 *
 * Se llama una vez al montar el panel. Sin esto, quien ya tenia
 * `tf_onboarding_done=1` de la version anterior seguiria con la guia apagada
 * y no veria la invitacion nueva.
 */
export function clearLegacyOnboardingKey() {
  try {
    localStorage.removeItem("tf_onboarding_done");
  } catch {
    /* sin storage: nada que limpiar */
  }
}
