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

/**
 * Rutas de superficie SIEMPRE oscura (vitrina, detalle, boleta publica,
 * escaner). Su candado oscuro (forceDarkOnce) corre en React — DESPUES del
 * primer paint —, asi que el tema claro no debe aplicarse aqui: si se aplica,
 * la pagina se pinta clara y salta a negra (FOLT, ~300ms medido).
 *
 * El script inline del <head> duplica esta lista (no puede importar) y
 * initTheme() la usa. Mantener en sincronia con las paginas que llaman
 * forceDarkOnce.
 */
export function isForcedDarkPath(pathname = window.location.pathname) {
  return (
    pathname === "/inicio" ||
    pathname === "/boletas" ||
    pathname === "/t" ||
    pathname === "/bouncer" ||
    pathname.startsWith("/evento/")
  );
}

/** Arranque: aplica tema y sigue los cambios del SO mientras sea "system". */
export function initTheme() {
  // En rutas de superficie oscura no se pinta claro: el candado llega en
  // React y hasta entonces el primer paint ya debe salir oscuro.
  applyDocument(isForcedDarkPath() ? "dark" : resolvedTheme());
  const mql = window.matchMedia?.("(prefers-color-scheme: light)");
  mql?.addEventListener?.("change", () => {
    if (getPreference() === "system" && !isForcedDarkPath()) {
      applyDocument(resolvedTheme());
    }
  });
}

/**
 * Fuerza oscuro (puerta): pone el candado data-theme-lock (el CSS repinta
 * body oscuro) y borra el atributo light, y devuelve el restaurador.
 *
 * El restaurador re-aplica la preferencia REAL del usuario (no solo si habia
 * light): en una ruta de superficie oscura el tema claro nunca llego a
 * aplicarse (ver isForcedDarkPath), asi que al salir hay que volver a
 * resolverlo — de lo contrario el tema del usuario se perdia hasta recargar.
 */
export function forceDarkOnce() {
  const root = document.documentElement;
  root.dataset.themeLock = "dark";
  delete root.dataset.theme;
  root.style.colorScheme = "";
  META_THEME?.setAttribute("content", DARK_BG);
  return () => {
    delete root.dataset.themeLock;
    applyDocument(resolvedTheme());
  };
}
