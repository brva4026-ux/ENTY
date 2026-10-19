import { useEffect, useState } from "react";
import { getPreference, resolvedTheme, setPreference } from "../lib/theme";
import { haptics } from "../lib/haptics";

/** Iconos sol/luna/auto (trazo 1.8, mismo lenguaje que el resto). */
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
      <path d="M7.5 12.2l2.4-3.4 2 2.4 1.5-1.9 2.6 2.9" />
    </svg>
  ),
};

const LABEL = { system: "Sistema", light: "Claro", dark: "Oscuro" };
const NEXT = { system: "light", light: "dark", dark: "system" };

/** Ciclo sistema → claro → oscuro. El ícono muestra el modo RESUELTO si el
    modo es sistema (lo que el usuario ve), con un puntito que delata "auto". */
export default function ThemeToggle() {
  const [pref, setPref] = useState(getPreference);
  const [resolved, setResolved] = useState(() => resolvedTheme());

  // Si está en "system", el ícono sigue al SO en vivo.
  useEffect(() => {
    if (pref !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const on = () => setResolved(resolvedTheme());
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [pref]);

  const shown = pref === "system" ? resolved : pref;
  const isAuto = pref === "system";

  return (
    <button
      onClick={() => {
        const next = NEXT[pref];
        setPreference(next);
        setPref(next);
        setResolved(resolvedTheme(next));
        haptics.tick();
      }}
      data-tip={`Tema: ${LABEL[pref]}${isAuto ? " (sigue al sistema)" : ""}`}
      aria-label={`Cambiar tema (actual: ${LABEL[pref]})`}
      className="relative grid h-8 w-8 place-items-center rounded-lg text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
    >
      <span className="theme-icon-swap" data-state={shown} aria-hidden="true">
        <span className="theme-icon" data-icon="light">
          {ICONS.light}
        </span>
        <span className="theme-icon" data-icon="dark">
          {ICONS.dark}
        </span>
      </span>
      {isAuto && (
        <span
          className="absolute right-1 top-1 h-1 w-1 rounded-full bg-brand-400"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
