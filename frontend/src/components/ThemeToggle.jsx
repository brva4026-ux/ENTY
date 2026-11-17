/* ThemeToggle — el interruptor de tema de la cabecera.
 *
 * Antes era un botón que CICLABA sistema → claro → oscuro a ciegas: el ícono
 * cambiaba sin decir a qué modo se iba ni cuál estaba activo, así que nadie
 * entendía qué pasaba al pulsarlo. Ahora abre un menú con las tres opciones a
 * la vista (Sistema / Claro / Oscuro), marca la activa con un check y explica
 * cada una. El mismo patrón de menú que la campana de notificaciones y el
 * menú "…": cierra al hacer click fuera y con Escape, y devuelve el foco.
 *
 * La preferencia vive en localStorage (tf_theme) y la aplica lib/theme.js
 * remapeando los tokens bajo html[data-theme="light"].
 *
 * El aria-label del botón DEBE empezar por "Cambiar tema": la regla de área
 * táctil del topbar (index.css, @media pointer:coarse) engancha por
 * [aria-label^="Cambiar tema"]; cambiar ese prefijo deja el botón a 32px.
 */
import { useEffect, useId, useRef, useState } from "react";
import { getPreference, resolvedTheme, setPreference } from "../lib/theme";
import { haptics } from "../lib/haptics";

/** Iconos (trazo 1.8, mismo lenguaje del resto de la app). */
const ICONS = {
  light: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className="h-[18px] w-[18px]"
    >
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
    </svg>
  ),
  dark: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
    >
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />
    </svg>
  ),
  system: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
    >
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20.5h6M12 16.5v4" />
    </svg>
  ),
};

const OPTIONS = ["system", "light", "dark"];
const LABEL = { system: "Sistema", light: "Claro", dark: "Oscuro" };
const DESC = {
  system: "Sigue la preferencia de tu dispositivo",
  light: "Ideal de día o en exteriores",
  dark: "Ideal de noche y en la puerta",
};

export default function ThemeToggle() {
  const [open, setOpen] = useState(false);
  const [pref, setPref] = useState(getPreference);
  const [resolved, setResolved] = useState(() => resolvedTheme());
  const rootRef = useRef(null);
  const btnRef = useRef(null);
  const menuId = useId();

  // Si está en "system", el ícono sigue al SO en vivo.
  useEffect(() => {
    if (pref !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const on = () => setResolved(resolvedTheme());
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [pref]);

  // Cerrar al hacer click fuera y con Escape (mismo patrón que la campana).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = pref === "system" ? resolved : pref;

  const choose = (opt) => {
    setPreference(opt);
    setPref(opt);
    setResolved(resolvedTheme(opt));
    haptics.tick();
    setOpen(false);
    btnRef.current?.focus();
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-tip={`Tema: ${LABEL[pref]}${pref === "system" ? " (sigue al sistema)" : ""}`}
        aria-label={`Cambiar tema: ${LABEL[pref]}`}
        className="topbar-hit relative grid h-8 w-8 place-items-center rounded-lg text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
      >
        {ICONS[shown]}
        {pref === "system" && (
          <span
            className="absolute right-1 top-1 h-1 w-1 rounded-full bg-brand-400"
            aria-hidden="true"
          />
        )}
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Tema de la aplicación"
          className="menu-pop absolute right-0 z-40 mt-2 w-60 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 p-1 shadow-xl shadow-black/40"
        >
          {OPTIONS.map((opt) => {
            const active = pref === opt;
            const shows = opt === "system" ? resolved : opt;
            return (
              <button
                key={opt}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => choose(opt)}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  active ? "bg-brand-500/10" : "hover:bg-zinc-800"
                }`}
              >
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
                    active
                      ? "bg-brand-500/15 text-brand-400"
                      : "bg-zinc-800/80 text-zinc-400"
                  }`}
                  aria-hidden="true"
                >
                  {ICONS[shows]}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-sm font-semibold ${
                      active ? "text-zinc-50" : "text-zinc-200"
                    }`}
                  >
                    {LABEL[opt]}
                    {opt === "system" && (
                      <span className="ml-1.5 text-2xs font-medium text-zinc-500">
                        ({resolved === "light" ? "claro ahora" : "oscuro ahora"})
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-2xs leading-tight text-zinc-500">
                    {DESC[opt]}
                  </span>
                </span>
                {active && (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4 shrink-0 text-brand-400"
                    aria-hidden="true"
                  >
                    <path d="M4.5 12.5l5 5 10-11" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
