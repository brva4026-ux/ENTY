/**
 * Guía de primeros pasos del admin, como DIÁLOGO enfocado (overlay).
 *
 * Antes vivía dentro del flujo del panel: la invitación medía 233px y el
 * checklist 458px, así que empujaba la portada y los eventos hacia abajo, y
 * encima se duplicaba con un botón "Primeros pasos" al final de la página.
 * Ahora hay UNA sola superficie, encima del contenido, y nada compite con él.
 *
 * Dos modos:
 *   mode="invite"    -> no decidió todavía: se le OFRECE (opt-in).
 *   mode="checklist" -> la aceptó o la pidió: pasos, progreso y confeti.
 *
 * La preferencia vive en lib/onboarding.js (por venue) y la controla el panel:
 * este componente solo la recibe como `mode` y avisa con onAccept / onDismiss /
 * onComplete. Volver a abrirla es cosa del botón del perfil.
 *
 * Se pinta por PORTAL a document.body: nace dentro de `.reveal`, cuyos hijos
 * llevan una animación de entrada con `transform` — eso lo vuelve containing
 * block de sus `fixed` y dejaría el diálogo desplazado y recortado. El portal
 * lo saca a la raíz (mismo motivo que DoorAlertBanner).
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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

  // Escape cierra: un diálogo sin salida de teclado deja atrapado a quien no
  // usa mouse.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onDismiss?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  // Celebra al completar y, unos segundos después, se retira: el momento se
  // guardó, la guía ya cumplió. onComplete deja la preferencia en "dismissed",
  // así que el botón del perfil queda disponible para volver a verla.
  useEffect(() => {
    if (mode !== "checklist" || !allDone || celebrate) return;
    setCelebrate(true);
    haptics.success();
    const t = setTimeout(() => onComplete?.(), 4000);
    return () => clearTimeout(t);
  }, [mode, allDone, celebrate, onComplete]);

  const closeBtn = (
    <button
      type="button"
      onClick={() => onDismiss?.()}
      aria-label="Cerrar la guía"
      data-testid="onboarding-close"
      className="rounded-full p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
        <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
      </svg>
    </button>
  );

  return createPortal(
    <div
      className="dialog-backdrop fixed inset-0 z-[80] flex items-end justify-center overflow-y-auto p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      data-testid="onboarding-guide"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss?.();
      }}
    >
      <div className="dialog-panel onboard-hero relative my-auto w-full max-w-md overflow-hidden p-5 animate-scale-in">
        <span aria-hidden="true" className="washi -left-3 -top-2 rotate-[-14deg]" />
        {allDone && mode === "checklist" && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {CONFETTI.map((emoji, i) => (
              <span
                key={i}
                className="confetti absolute text-xl"
                style={{ left: `${12 + i * 18}%`, animationDelay: `${i * 0.12}s` }}
              >
                {emoji}
              </span>
            ))}
          </div>
        )}

        {mode === "invite" ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="eyebrow">Primeros pasos</p>
                <h3 id="onboarding-title" className="display mt-0.5 text-base">
                  👋 ¿Te guío en la configuración?
                </h3>
              </div>
              {closeBtn}
            </div>
            <p className="max-w-sm text-sm text-zinc-500">
              Son 4 pasos y unos 3 minutos: crear el evento, definir los tipos
              de boleta, asignar cupos y publicar. Si preferís, lo hacés por tu
              cuenta y volvés a la guía desde tu perfil.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => onAccept?.()}
                data-testid="onboarding-accept"
                className="btn-primary !px-3 !py-1.5 text-xs"
              >
                Sí, guiame
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
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="eyebrow">Primeros pasos</p>
                <h3 id="onboarding-title" className="display mt-0.5 text-base">
                  {allDone ? "¡Todo listo para vender! 🎉" : "Pon tu negocio a vender"}
                </h3>
              </div>
              {closeBtn}
            </div>
            <p className="max-w-xs text-sm text-zinc-500">
              {allDone
                ? "Completaste los 4 pasos. Podés volver a esta guía desde tu perfil cuando quieras."
                : "Cada paso es un atajo directo a la sección donde lo resolvés."}
            </p>
            {/* CTA del primer paso: la guía no solo informa, EJECUTA. Sin esto el
              admin primerizo lee "crea tu primer evento" y sale a buscar el botón. */}
            {!allDone && (onStart || onGo) && (
              <button
                autoFocus
                onClick={() => {
                  const next = steps.find((s) => !s.done);
                  if (!hasEvent && onStart) return onStart();
                  if (next?.go && onGo) return onGo(next.go);
                  if (onStart) onStart();
                }}
                className="btn-primary self-start !px-3 !py-1.5 text-xs"
              >
                {hasEvent ? "Siguiente paso" : "Crear evento"}
              </button>
            )}

            {/* Progreso real (no solo el contador): la barra crece con cada paso
              completado — ver el avance mueve más que leerlo. */}
            <div className="onboard-progress-wrapper">
              <div className="flex items-center gap-2">
                <div className="onboard-progress-bar flex-1">
                  <div
                    className="onboard-progress-fill"
                    style={{ width: `${(doneCount / steps.length) * 100}%` }}
                  />
                </div>
                <span className="tnum text-2xs font-semibold text-zinc-400">
                  {doneCount}/{steps.length}
                </span>
              </div>
            </div>

            <ol className="mt-2 space-y-2.5">
              {steps.map((s, i) => {
                // Paso pendiente = atajo a su pestaña. El hecho no navega: no
                // hay nada que arreglar ahí.
                const actionable = !s.done && s.go && onGo;
                const body = (
                  <>
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
        )}
      </div>
    </div>,
    document.body
  );
}
