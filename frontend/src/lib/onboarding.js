/**
 * Preferencias del panel (guia de primeros pasos y tutorial), por usuario y
 * negocio.
 *
 * Historia de este modulo, porque explica por que tiene la forma que tiene:
 *
 * 1. La clave era global (`tf_onboarding_done`) y la escribian dos sitios: el
 *    boton de descartar y —sin decirlo— el modal de crear evento. La guia se
 *    apagaba en el paso 1 de 4 y los pasos 2-4 no se veian nunca.
 * 2. Se paso a clave por venue en localStorage (`tf_onboarding:<venue>`), que
 *    arreglo lo del venue pero dejo el problema de fondo: localStorage es por
 *    NAVEGADOR, no por persona. El mismo admin que ya habia dicho "Lo hago
 *    solo" en la laptop volvia a ver la invitacion en el celular, y el dominio
 *    de preview de Vercel (otro origen) no veia la decision de produccion.
 *
 * Ahora la decision vive en el SERVIDOR (`/auth/me/preferences`, mig 032), por
 * (usuario, venue): la decision es de la persona, en cualquier dispositivo.
 * localStorage queda solo como CACHE de pintado, para que el panel no muestre
 * la guia un instante y la esconda cuando llega la respuesta.
 *
 * Estados:
 *   "pending"   -> no decidio todavia: se le OFRECE la guia (opt-in)
 *   "accepted"  -> la quiere: se muestra y se retoma donde quedo
 *   "dismissed" -> la rechazo o la cerro: no se muestra sola nunca mas
 *   "completed" -> la termino: no se muestra sola nunca mas
 *
 * Volver a mostrarla SIEMPRE es posible desde Configuracion > Ayuda: nada de
 * esto es irreversible.
 */
import { apiFetch } from "./api";

/** Claves conocidas; el backend las devuelve siempre, aunque no haya fila. */
export const PREF_ONBOARDING = "onboarding";
export const PREF_TUTORIAL = "tutorial";

const CACHE_PREFIX = "tf_prefs";

/** Clave de cache por venue: el pintado de un negocio no usa el de otro. */
function cacheKey(venueId) {
  return venueId ? `${CACHE_PREFIX}:${venueId}` : CACHE_PREFIX;
}

function readCache(venueId) {
  try {
    const raw = localStorage.getItem(cacheKey(venueId));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCache(venueId, prefs) {
  try {
    localStorage.setItem(cacheKey(venueId), JSON.stringify(prefs));
  } catch {
    /* sin storage: la proxima carga lee del servidor */
  }
}

/**
 * Estado cacheado, para el PRIMER render (evita el parpadeo de la guia).
 * La verdad siempre es la respuesta del servidor; esto es solo el adelanto.
 */
export function cachedPreferences(venueId) {
  return readCache(venueId);
}

/**
 * Preferencias del servidor. Devuelve `{onboarding: {...}, tutorial: {...}}`
 * con `value` y `step`. Si la red falla, cae al cache: sin conexion el panel
 * no debe perder la decision ya tomada.
 */
export async function loadPreferences(venueId) {
  if (!venueId) return {};
  try {
    const data = await apiFetch(`/auth/me/preferences?venue_id=${venueId}`);
    const prefs = {};
    for (const p of data.preferences ?? []) {
      prefs[p.key] = { value: p.value, step: p.step ?? 0 };
    }
    writeCache(venueId, prefs);
    return prefs;
  } catch {
    return readCache(venueId);
  }
}

/**
 * Guarda una decision. Actualiza el cache ANTES de la red para que la UI no
 * dependa de la latencia, y propaga el error para que quien llama pueda
 * revertir si el servidor la rechaza.
 */
export async function savePreference(venueId, key, value, step = null) {
  const prefs = readCache(venueId);
  prefs[key] = { value, step: step ?? prefs[key]?.step ?? 0 };
  writeCache(venueId, prefs);
  const body = { value };
  if (step !== null) body.step = step;
  const saved = await apiFetch(
    `/auth/me/preferences/${key}?venue_id=${venueId}`,
    { method: "PUT", body: JSON.stringify(body) }
  );
  const after = readCache(venueId);
  after[key] = { value: saved.value, step: saved.step ?? 0 };
  writeCache(venueId, after);
  return after[key];
}

/**
 * Limpieza de claves viejas de versiones anteriores, que vivian en
 * localStorage y ya no se leen. Se llama una vez al montar el panel.
 *
 * OJO con el estado heredado: quien haya rechazado la guia en su navegador
 * queda en `dismissed` local, pero en el servidor no tiene fila, asi que se le
 * vuelve a ofrecer UNA vez. Es lo correcto: la version nueva de la guia
 * (tutorial guiado) es otra cosa y merece una sola oferta; si dice "no", el
 * "no" queda en el servidor y no vuelve a aparecer.
 */
export function clearLegacyOnboardingKeys() {
  try {
    localStorage.removeItem("tf_onboarding_done");
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("tf_onboarding:")) localStorage.removeItem(k);
    }
  } catch {
    /* sin storage: nada que limpiar */
  }
}
