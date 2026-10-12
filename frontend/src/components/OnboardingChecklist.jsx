/**
 * OnboardingChecklist: guía al admin primerizo por los 4 pasos para vender
 * su primer evento. Se oculta solo (queda completado + descartado) para no
 * estorbar a quien ya sabe lo que hace. Micro-confeti de emojis al completar
 * todo — un momento especial medido, sin saturar.
 */
import { useEffect, useState } from "react";
import { haptics } from "../lib/haptics";

const DISMISS_KEY = "tf_onboarding_done";

const CONFETTI = ["🎉", "🎟️", "✨", "🎊", "🥳"];

export function OnboardingChecklist({ hasEvent, hasTypes, hasAllocations, isPublished, onStart }) {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === "1"
  );
  const [celebrate, setCelebrate] = useState(false);

  const steps = [
    { done: hasEvent, label: "Crea tu primer evento", hint: "Nombre, fecha y aforo" },
    { done: hasTypes, label: "Define tipos de boleta", hint: "General, VIP, cortesías…" },
    { done: hasAllocations, label: "Asigna cupos a tu equipo", hint: "Cada promotor vende dentro de su cupo" },
    { done: isPublished, label: "Publica y abre puertas", hint: "Publica para vender; en puerta, escanea QR" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  useEffect(() => {
    if (allDone && !celebrate) {
      setCelebrate(true);
      haptics.success();
      const t = setTimeout(() => {
        localStorage.setItem(DISMISS_KEY, "1");
        setDismissed(true);
      }, 4000);
      return () => clearTimeout(t);
    }
  }, [allDone, celebrate]);

  if (dismissed) return null;

  return (
    <div className="card onboard-hero relative overflow-hidden p-5 animate-scale-in">
      {/* Cinta washi (scrapbook): la guía llega "pegada" al panel */}
      <span aria-hidden="true" className="washi -left-3 -top-2 rotate-[-14deg]" />
      {allDone && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          {CONFETTI.map((emoji, i) => (
            <span
              key={i}
              className="confetti absolute text-xl"
              style={{
                left: `${12 + i * 18}%`,
                animationDelay: `${i * 0.12}s`,
              }}
            >
              {emoji}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Primeros pasos</p>
          <h3 className="display mt-0.5 text-base">
            {allDone ? "¡Todo listo para vender! 🎉" : "Pon tu negocio a vender"}
          </h3>
        </div>
        {/* CTA del primer paso: la guía no solo informa, EJECUTA. Sin esto el
          admin primerizo lee "crea tu primer evento" y sale a buscar el botón. */}
        {!allDone && onStart && (
          <button onClick={onStart} className="btn-primary !px-3 !py-1.5 text-xs">
            {hasEvent ? "Continuar" : "Crear evento"}
          </button>
        )}
        <div className="flex items-center gap-2">
          <span className="tnum rounded-full bg-zinc-800 px-2 py-0.5 text-2xs font-semibold text-zinc-300">
            {doneCount}/{steps.length}
          </span>
          <button
            onClick={() => {
              localStorage.setItem(DISMISS_KEY, "1");
              setDismissed(true);
            }}
            aria-label="Ocultar guía"
            className="rounded-full p-1 text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-300"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Progreso real (no solo el contador): la barra crece con cada paso
        completado — ver el avance mueve más que leerlo. */}
      <div className="onboard-progress mt-3" role="progressbar" aria-valuenow={doneCount} aria-valuemin={0} aria-valuemax={steps.length}>
        <div className="onboard-progress-fill" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>

      <ol className="mt-3 space-y-2.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-3">
            <span
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold transition-all duration-300 ${
                s.done
                  ? "scale-110 bg-emerald-500 text-white"
                  : "bg-zinc-800 text-zinc-500 ring-1 ring-zinc-700"
              }`}
            >
              {s.done ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                i + 1
              )}
            </span>
            <div className="min-w-0">
              <p className={`text-sm font-medium ${s.done ? "text-zinc-500 line-through decoration-zinc-700" : "text-zinc-200"}`}>
                {s.label}
              </p>
              <p className="text-xs text-zinc-600">{s.hint}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
