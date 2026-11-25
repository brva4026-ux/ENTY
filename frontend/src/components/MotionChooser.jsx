import { useEffect, useState } from "react";
import {
  applyMotion,
  getMotionPreference,
  setMotionPreference,
  systemPrefersReduced,
  watchSystemMotion,
} from "../lib/motion";
import { haptics } from "../lib/haptics";

/** Iconos (trazo 1.8, mismo lenguaje que ThemeChooser). */
const ICONS = {
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
  reduce: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <path d="M4 12h16" />
      <path d="M7 8.5h10M7 15.5h10" opacity="0.45" />
    </svg>
  ),
};

const LABEL = { system: "Sistema", reduce: "Reducido" };
const DESC = {
  system: "Sigue la configuración de tu dispositivo",
  reduce: "Sin movimiento: todo aparece en su sitio",
};

/** Movimiento: dos opciones, mismo patrón que el selector de tema.
 *  "Sistema" respeta `prefers-reduced-motion`; "Reducido" lo pide siempre. */
export default function MotionChooser() {
  const [pref, setPref] = useState(getMotionPreference);
  const [sysReduce, setSysReduce] = useState(systemPrefersReduced);

  // El SO puede cambiar mientras la app está abierta (ajuste del sistema,
  // batería baja). El selector tiene que reflejar la verdad, no la foto
  // del montaje.
  useEffect(() => watchSystemMotion(() => setSysReduce(systemPrefersReduced())), []);

  useEffect(() => {
    applyMotion(pref);
  }, [pref]);

  return (
    <div className="space-y-2">
      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        role="radiogroup"
        aria-label="Movimiento de la aplicación"
      >
        {["system", "reduce"].map((opt) => {
          const active = pref === opt;
          return (
            <button
              key={opt}
              role="radio"
              aria-checked={active}
              onClick={() => {
                setMotionPreference(opt);
                setPref(opt);
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
                {ICONS[opt]}
              </span>
              <span className="min-w-0">
                <span
                  className={`block text-sm font-semibold ${active ? "text-zinc-50" : "text-zinc-300"}`}
                >
                  {LABEL[opt]}
                </span>
                <span className="block text-2xs leading-tight text-zinc-500">
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

      {/* Cuando el SO pide menos movimiento, decirlo: "Sistema" ya lo
          respeta, así que no hay que deshabilitar una opción ni adivinar. */}
      {sysReduce && (
        <p className="pf-hint" role="status">
          Tu dispositivo pide menos movimiento, así que la opción "Sistema"
          lo respeta.
        </p>
      )}
    </div>
  );
}
