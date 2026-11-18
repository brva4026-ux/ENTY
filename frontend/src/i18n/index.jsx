/**
 * Capa React de i18n sobre el nucleo de i18nCore.js.
 *
 * Estado global minimo: un solo idioma activo, persistido en localStorage
 * (`enty_locale`). Por defecto ESPAÑOL: es la lengua del producto y no cambia
 * nada de lo que ya se veia (los E2E y el texto en pantalla siguen igual).
 *
 * Uso en un componente:
 *   const { t } = useI18n();
 *   <h1>{t("login.title")}</h1>
 *   <p>{t("login.greeting", { name })}</p>
 *
 * `t` cambia de identidad solo cuando cambia el idioma, asi que sirve como
 * dependencia estable de useMemo/useCallback.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { DEFAULT_LOCALE, LOCALES, translate } from "../lib/i18nCore";
import es from "./es";
import en from "./en";

const CATALOGS = { es, en };
const STORAGE_KEY = "enty_locale";

function initialLocale() {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  // SOLO una eleccion explicita cambia el idioma. NO se mira
  // navigator.language: la UI del producto es español y la mayoria de los
  // usuarios tienen el navegador en inglés (móvil por defecto), así que
  // autodetectarlo cambiaría la app a un idioma que nadie pidió. El español
  // es el default y sigue siéndolo hasta que la persona elija otro.
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved && LOCALES.includes(saved)) return saved;
  return DEFAULT_LOCALE;
}

const I18nContext = createContext(null);

export function I18nProvider({ children, locale: forced }) {
  const [locale, setLocaleState] = useState(() => forced || initialLocale());

  const setLocale = useCallback((next) => {
    if (!LOCALES.includes(next)) return;
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* almacenamiento no disponible: el idioma dura esta sesion */
    }
  }, []);

  // `lang` correcto en <html> para lectores de pantalla y para la propia
  // traduccion nativa del navegador (p. ej. el corrector ortografico).
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const t = useCallback(
    (key, vars) => translate(CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE], key, vars),
    [locale],
  );

  const value = useMemo(
    () => ({ t, locale, setLocale, locales: LOCALES }),
    [t, locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Acceso al traductor. Fuera del provider devuelve el espanol (sin romper). */
export function useI18n() {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  return {
    t: (key, vars) => translate(es, key, vars),
    locale: DEFAULT_LOCALE,
    setLocale: () => {},
    locales: LOCALES,
  };
}
