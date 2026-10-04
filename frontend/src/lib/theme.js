/**
 * Tema claro/oscuro con preferencia persistente.
 *
 * Estrategia: el design system vive en clases propias (.card, .field, …) y
 * en utilidades zinc-* de Tailwind v4, que compilan a variables CSS
 * (--color-zinc-*). El modo claro REMAPEA esas variables bajo
 * html[data-theme="light"] (index.css): toda la app voltea sin tocar un
 * solo JSX. El oscuro sigue siendo el default (sin atributo = dark).
 *
 * EXCEPCIÓN: la puerta (/bouncer) se fuerza oscura siempre — en un recinto
 * a oscuras un flash de fondo blanco cega al portero (patrón Xceed Access).
 *
 * La preferencia se guarda en localStorage (tf_theme): "system" | "light" |
 * "dark". El HTML trae un script inline que aplica el atributo ANTES del
 * primer paint (cero flash blanco al cargar en claro).
 */
const KEY = "tf_theme";

const META_THEME = document.querySelector('meta[name="theme-color"]');
/* El meta theme-color tiene que coincidir con el lienzo real de cada tema
   (los mismos valores que html[data-theme="light"] body y :root en
   index.css): si no, la barra del navegador en Android muestra el gris
   viejo mientras la app ya esta en navy. */
const DARK_BG = "#070c17";
const LIGHT_BG = "#eef1f8";

/** Preferencia guardada (default: seguir al sistema). */
export function getPreference() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

/** Resolución efectiva: system → lo que dice el SO ahora. */
export function resolvedTheme(pref = getPreference()) {
  if (pref !== "system") return pref;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** Aplica el tema resuelto al documento (atributo + color-scheme + meta). */
export function applyDocument(resolved) {
  const root = document.documentElement;
  if (resolved === "light") {
    root.dataset.theme = "light";
    root.style.colorScheme = "light";
    META_THEME?.setAttribute("content", LIGHT_BG);
  } else {
    delete root.dataset.theme;
    root.style.colorScheme = "";
    META_THEME?.setAttribute("content", DARK_BG);
  }
}

/** Cambia la preferencia y la aplica. */
export function setPreference(pref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* modo privado: se aplica sin persistir */
  }
  applyDocument(resolvedTheme(pref));
}

/** Arranque: aplica tema y sigue los cambios del SO mientras sea "system". */
export function initTheme() {
  applyDocument(resolvedTheme());
  const mql = window.matchMedia?.("(prefers-color-scheme: light)");
  mql?.addEventListener?.("change", () => {
    if (getPreference() === "system") applyDocument(resolvedTheme());
  });
}

/**
 * Fuerza oscuro (puerta): borra el atributo light, pone el candado
 * data-theme-lock (el CSS repinta body oscuro con !important) y devuelve
 * el restaurador, que re-aplica la preferencia real del usuario.
 */
export function forceDarkOnce() {
  const root = document.documentElement;
  const hadLight = root.dataset.theme === "light";
  if (hadLight) delete root.dataset.theme;
  root.dataset.themeLock = "dark";
  root.style.colorScheme = "";
  META_THEME?.setAttribute("content", DARK_BG);
  return () => {
    delete root.dataset.themeLock;
    if (hadLight) applyDocument("light");
  };
}
