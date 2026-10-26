/**
 * Guia de primeros pasos del admin nuevo. Dos modos:
 *
 *   mode="invite"    -> aun no decidio: se le OFRECE la guia (opt-in). Dos
 *                       salidas claras: aceptarla o rechazarla.
 *   mode="checklist" -> la acepto: pasos, progreso y confeti al completar.
 *
 * La preferencia vive en lib/onboarding.js (por venue) y la controla el panel:
 * este componente solo la recibe como `mode` y avisa con onAccept / onDismiss /
 * onComplete. Antes la decision era un efecto colateral del modal de crear
 * evento y no habia forma de volver a mostrar la guia.
 */
import { useEffect, useState } from "react";
import { haptics } from "../lib/haptics";

const CONFETTI = ["🎉", "🎟️", "✨", "🎊", "🥳"];

export function OnboardingChecklist({
  mode = "checklist",
  hasEvent,
  hasTypes,
  hasAllocations,
  isPublished,
  onStart,
  onGo,
  onTour,
  onAccept,
  onDismiss,
  onComplete,
}) {
  const [celebrate, setCelebrate] = useState(false);

  const steps = [
    { done: hasEvent, label: "Crear tu primer evento", hint: "Nombre, fecha y aforo del evento", go: "evento" },
    { done: hasTypes, label: "Definir tipos de boleta", hint: "General, VIP, cortesías y descuentos", go: "entradas" },
    { done: hasAllocations, label: "Asignar cupos al equipo", hint: "Distribuye cupos por promotor vendedor", go: "cupos" },
    { done: isPublished, label: "Publicar y abrir puertas", hint: "Habilita venta; en puerta escanea QR al ingreso", go: "resumen" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  // Celebra al completar y, unos segundos despues, se retira: el momento se
  // guardo, la guia ya cumplio. onComplete deja la preferencia en "dismissed",
  // asi que el acceso para volver a abrirla queda disponible.
  useEffect(() => {
    if (mode !== "checklist" || !allDone || celebrate) return;
    setCelebrate(true);
    haptics.success();
    const t = setTimeout(() => onComplete?.(), 4000);
    return () => clearTimeout(t);
  }, [mode, allDone, celebrate, onComplete]);

  if (mode === "invite") {
    return (
      <div className="card onboard-hero relative overflow-hidden p-5 animate-scale-in">
        <span aria-hidden="true" className="washi -left-3 -top-2 rotate-[-14deg]" />
        <div className="flex flex-col gap-3">
          <div>
            <p className="eyebrow">Primeros pasos</p>
            <h3 className="display mt-0.5 text-base">
              👋 ¿Te muestro dónde está todo?
            </h3>
          </div>
          <p className="text-zinc-500 text-sm max-w-sm">
            Son 4 pasos y unos 3 minutos: crear el evento, definir los tipos de
            boleta, asignar cupos y publicar. Te voy señalando dónde presionar
            en cada uno. Si preferís, lo hacés por tu cuenta.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onAccept?.()}
              data-testid="onboarding-accept"
              className="btn-primary !px-3 !py-1.5 text-xs"
            >
              Sí, mostrame
            </button>
            <button
              type="button"
              onClick={() => onDismiss?.()}
              data-testid="onboarding-decline"
              className="btn-ghost !px-3 !py-1.5 text-xs"
            >
              Lo hago solo
            </button>
          </div>
        </div>
      </div>
    );
  }

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

      <div className="flex flex-col gap-2">
        <div>
          <p className="eyebrow">Primeros pasos</p>
          <h3 className="display mt-0.5 text-base">
            {allDone ? "¡Todo listo para vender! 🎉" : "Pon tu negocio a vender"}
          </h3>
        </div>
        <p className="text-zinc-500 text-sm max-w-xs">
          Complete cada paso para poner tu negocio a vender. Son atajos directos
          a las secciones donde resolvés cada tarea.
        </p>
        {/* CTA del primer paso: la guía no solo informa, EJECUTA. Sin esto el
          admin primerizo lee "crea tu primer evento" y sale a buscar el botón.
          Una vez hay evento, el botón lleva al paso pendiente más temprano. */}
        {!allDone && (onStart || onGo) && (
          <button
            onClick={() => {
              const next = steps.find((s) => !s.done);
              if (!hasEvent && onStart) return onStart();
              if (next?.go && onGo) return onGo(next.go);
              if (onStart) onStart();
            }}
            className="btn-primary !px-3 !py-1.5 text-xs"
          >
            {hasEvent ? "Siguiente paso" : "Crear evento"}
          </button>
        )}
        {/* Tutorial guiado: la guía dice QUÉ falta, el tutorial señala DÓNDE
          está. Son complementarios, no dos versiones de lo mismo. */}
        {onTour && (
          <button
            type="button"
            onClick={onTour}
            data-testid="onboarding-tour"
            className="btn-ghost !px-3 !py-1.5 text-xs self-start"
          >
            🎯 Muéstrame dónde
          </button>
        )}
        <div className="flex items-center gap-2">
          <span className="tnum rounded-full bg-zinc-800 px-2 py-0.5 text-2xs font-semibold text-zinc-300">
            {doneCount}/{steps.length}
          </span>
          <button
            onClick={() => onDismiss?.()}
            aria-label="Ocultar guía"
            data-testid="onboarding-hide"
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
      <div className="onboard-progress-wrapper">
        <div className="onboard-progress-label">
          <span className="onboard-progress-done">{doneCount}</span>
          <span className="onboard-progress-total">de {steps.length}</span>
        </div>
        <div className="onboard-progress-bar">
          <div className="onboard-progress-fill" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
      </div>

      <ol className="mt-3 space-y-2.5">
        {steps.map((s, i) => {
          // Paso pendiente = atajo a su pestaña. El hecho (hecho) no navega:
          // no hay nada que arreglar ahí.
          const actionable = !s.done && s.go && onGo;
          const body = (
            <>
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold transition-[transform,background-color] duration-300 ${
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
              <div className="min-w-0 text-left">
                <p className={`text-sm font-medium ${s.done ? "text-zinc-500 line-through decoration-zinc-700" : "text-zinc-200"}`}>
                  {s.label}
                </p>
                <p className="text-xs text-zinc-600">{s.hint}</p>
              </div>
            </>
          );
          return (
            <li key={i}>
              {actionable ? (
                <button
                  type="button"
                  onClick={() => onGo(s.go)}
                  className="flex w-full items-center gap-3 rounded-lg transition hover:bg-zinc-800/50"
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-center gap-3">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Acceso permanente a la guia cuando esta oculta. Ocupa el mismo sitio que la
 * guia (su "casa"), asi que se encuentra donde se la vio por ultima vez.
 *
 * Dos caminos, porque son dos necesidades distintas: la LISTA dice que falta
 * hacer, el TUTORIAL senala donde esta cada cosa. Quien cerro la guia por
 * accidente quiere la lista; quien no entiende la pantalla quiere el tutorial.
 */
export function OnboardingResume({ onRestart, onTour }) {
  return (
    <div className="card flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
      <span aria-hidden="true">🎯</span>
      <span className="text-sm text-zinc-300">Primeros pasos</span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => onRestart?.()}
          data-testid="onboarding-resume"
          className="btn-ghost !px-3 !py-1.5 text-xs"
        >
          Ver la guía
        </button>
        {onTour && (
          <button
            type="button"
            onClick={() => onTour?.()}
            data-testid="onboarding-resume-tour"
            className="btn-ghost !px-3 !py-1.5 text-xs"
          >
            Ver el tutorial
          </button>
        )}
      </div>
    </div>
  );
}
