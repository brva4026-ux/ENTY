import { useEffect, useState } from "react";
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
      className="h-5 w-5"
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
      className="h-5 w-5"
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
      className="h-5 w-5"
    >
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20.5h6M12 16.5v4" />
    </svg>
  ),
};

const LABEL = { system: "Sistema", light: "Claro", dark: "Oscuro" };
const DESC = {
  system: "Sigue la preferencia de tu dispositivo",
  light: "Ideal de día o en exteriores",
  dark: "Ideal de noche y en la puerta",
};

/** Tarjetas seleccionables: las tres opciones a la vista, el modo activo
    marcado con borde de marca y check. Cada opción es ≥44px de alto. */
export default function ThemeChooser() {
  const [pref, setPref] = useState(getPreference);
  const [resolved, setResolved] = useState(() => resolvedTheme());

  // En "sistema", la tarjeta activa muestra qué modo está ganando ahora.
  useEffect(() => {
    if (pref !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const on = () => setResolved(resolvedTheme());
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [pref]);

  return (
    <div
      className="grid grid-cols-1 gap-2 sm:grid-cols-3"
      role="radiogroup"
      aria-label="Tema de la aplicación"
    >
      {["system", "light", "dark"].map((opt) => {
        const active = pref === opt;
        const showsResolved = opt === "system" ? resolved : opt;
        return (
          <button
            key={opt}
            role="radio"
            aria-checked={active}
            onClick={() => {
              setPreference(opt);
              setPref(opt);
              setResolved(resolvedTheme(opt));
              haptics.tick();
            }}
            className={`relative flex min-h-[44px] items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition ${
              active
                ? "border-brand-500/70 bg-brand-500/[0.07]"
                : "border-zinc-800/80 hover:border-zinc-700 hover:bg-zinc-900/50"
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
              {ICONS[showsResolved]}
            </span>
            <span className="min-w-0">
              <span
                className={`block text-sm font-semibold ${active ? "text-zinc-50" : "text-zinc-300"}`}
              >
                {LABEL[opt]}
                {opt === "system" && (
                  <span className="ml-1.5 text-2xs font-medium text-zinc-500">
                    (
                    {showsResolved === "light" ? "claro ahora" : "oscuro ahora"}
                    )
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
                className="ml-auto h-4 w-4 shrink-0 text-brand-400"
                aria-hidden="true"
              >
                <path d="M4.5 12.5l5 5 10-11" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}
