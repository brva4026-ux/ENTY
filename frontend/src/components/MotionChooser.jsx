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
  full: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <path d="M3 12h4l2.5-6 4 12L16 12h5" />
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

const LABEL = { full: "Completo", reduce: "Reducido" };
const DESC = {
  full: "Transiciones y animaciones de la app",
  reduce: "Sin movimiento: todo aparece en su sitio",
};

/** Movimiento: dos opciones, mismo patrón que el selector de tema.
 *  El sistema operativo siempre gana: si el dispositivo pide menos
 *  movimiento, "Completo" queda deshabilitado y se explica por qué. */
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
        {["full", "reduce"].map((opt) => {
          const active = pref === opt;
          const locked = opt === "full" && sysReduce;
          return (
            <button
              key={opt}
              role="radio"
              aria-checked={active}
              disabled={locked}
              onClick={() => {
                setMotionPreference(opt);
                setPref(opt);
                haptics.tick();
              }}
              className={`relative flex min-h-[44px] items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition ${
                active
                  ? "border-brand-500/70 bg-brand-500/[0.07]"
                  : "border-zinc-800/80 hover:border-zinc-700 hover:bg-zinc-900/50"
              } ${locked ? "cursor-not-allowed opacity-50" : ""}`}
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

      {/* Cuando el SO pide menos movimiento, decirlo: si no, el botón
          deshabilitado parece un fallo y no una decisión del dispositivo. */}
      {sysReduce && (
        <p className="pf-hint" role="status">
          Tu dispositivo pide menos movimiento, así que Enty lo respeta: la
          opción "Completo" vuelve a estar disponible si lo cambias en los
          ajustes de tu sistema.
        </p>
      )}
    </div>
  );
}
