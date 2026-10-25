/**
 * Motor del tutorial guiado ("Primeros pasos").
 *
 * Por que a mano y no una libreria (driver.js, shepherd, intro.js):
 *   * el CSP de la app es estricto por hash (vercel.json): una dependencia
 *     nueva obliga a revisar el CSP;
 *   * son ~200 lineas de overlay + recorte, no una funcionalidad grande;
 *   * el proyecto ya tiene su lenguaje visual (`.card`, `dialog-backdrop`).
 *
 * Como funciona:
 *   1. Cada paso apunta a un ancla `[data-tour="<id>"]` presente en el DOM.
 *   2. Se mide su rectangulo y se abre un "recorte" (box-shadow gigante) sobre
 *      el, que oscurece TODO lo demas y deja el elemento enfocado.
 *   3. El tooltip se ancla arriba o abajo segun el espacio; en movil (<=640px)
 *      se convierte en una hoja fija abajo, porque un tooltip anclado a un
 *      elemento chico a 390px se sale de la pantalla.
 *   4. Si el ancla no existe todavia (el panel sigue cargando) el paso espera;
 *      si sigue sin existir, se SALTA. El tutorial nunca queda en un paso
 *      fantasma senalando la nada.
 *
 * El paso y el estado viven en el servidor (lib/onboarding.js): cerrar la app
 * no pierde el avance.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Margen del recorte alrededor del ancla (px): respira, no la pega al borde. */
const HOLE_PAD = 6;
/** Separacion entre el ancla y el tooltip. */
const TIP_GAP = 12;
/** Alto maximo de la hoja del tooltip en movil. */
const MOBILE_SHEET_MAX = 260;
/** Reintentos de medicion antes de saltar un paso sin ancla. */
const MAX_TRIES = 12;

/**
 * Los pasos del tutorial. `anchor` apunta a un `[data-tour]` del panel; los
 * pasos cuyo ancla no exista en la pantalla se saltan solos.
 *
 * El orden sigue el flujo real de trabajo: entender la portada, crear el
 * evento, montarlo (tipos y cupos) y abrir puertas. Cada `body` dice DÓNDE
 * presionar, que es lo que el admin primerizo no sabe.
 *
 * `screen` es la pantalla donde vive el ancla ("list" = modo lista del panel,
 * "event" = backstage). El panel navega al entrar en un paso: el tutorial no
 * puede explicar el backstage desde la lista.
 */
export const ONBOARDING_STEPS = [
  {
    anchor: "portada",
    screen: "list",
    title: "Esta es tu portada",
    body: "Arriba está la identidad de tu negocio y cuánto llevas vendido este mes. El navegador de meses te deja mirar otro período.",
  },
  {
    anchor: "eventos",
    screen: "list",
    title: "Tus eventos viven aquí",
    body: "Cada tarjeta es una noche. Toca una para entrar a su backstage; los filtros de arriba separan borradores, eventos a la venta y en puerta.",
  },
  {
    anchor: "nuevo-evento",
    screen: "list",
    title: "Crea tu primer evento",
    body: "Presiona este botón para crear una noche. Nace en borrador: la montas antes de vender.",
  },
  {
    anchor: "backstage",
    screen: "event",
    title: "Este es el backstage",
    body: "Aquí montas la noche: nombre, fecha, aforo y el botón para publicarla cuando esté lista.",
  },
  {
    anchor: "tabs-evento",
    screen: "event",
    title: "Las pestañas del evento",
    body: "En Entradas defines los tipos de boleta; en Cupos repartes cupos a tu equipo; en Boletas ves las vendidas; en Equipo asignas quién trabaja la noche.",
  },
  {
    anchor: "negocio",
    screen: "list",
    title: "Del negocio, siempre a mano",
    body: "Estas secciones no dependen del evento: reportes, equipo, liquidaciones, puerta y cobros viven acá abajo.",
  },
];

function isMobile() {
  return window.matchMedia("(max-width: 640px)").matches;
}

/** Elemento del ancla, o null si no existe o no tiene caja. */
function anchorOf(anchorId) {
  const el = document.querySelector(`[data-tour="${anchorId}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { el, rect: r };
}

export default function OnboardingTour({
  steps,
  step: initialStep = 0,
  onStep,
  onExit,
  onFinish,
}) {
  const [i, setI] = useState(initialStep);
  const [box, setBox] = useState(null);
  const [missing, setMissing] = useState(false);
  const [confirmingExit, setConfirmingExit] = useState(false);
  const tipRef = useRef(null);
  const triesRef = useRef(0);

  const total = steps.length;
  const step = steps[Math.min(i, Math.max(total - 1, 0))];

  // Medir el ancla actual. Devuelve false si aun no esta en el DOM.
  const measure = useCallback(() => {
    const found = anchorOf(step.anchor);
    if (!found) {
      setBox(null);
      setMissing(true);
      return false;
    }
    setMissing(false);
    const { rect } = found;
    const mobile = isMobile();
    const tipH = tipRef.current?.offsetHeight ?? 0;
    // Arriba si abajo no cabe y arriba si cabe; si no cabe en ninguno, abajo
    // (es donde suele haber mas aire).
    const place =
      !mobile &&
      rect.bottom + TIP_GAP + tipH > window.innerHeight &&
      rect.top > tipH + TIP_GAP
        ? "top"
        : "bottom";
    setBox({
      top: rect.top - HOLE_PAD,
      left: rect.left - HOLE_PAD,
      width: rect.width + HOLE_PAD * 2,
      height: rect.height + HOLE_PAD * 2,
      place,
      mobile,
    });
    return true;
  }, [step]);

  // El ancla se trae a la vista: el tutorial dice donde presionar, asi que el
  // boton tiene que estar en pantalla.
  useEffect(() => {
    const found = anchorOf(step.anchor);
    if (found && found.rect.top < 0) {
      found.el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [step]);

  // Medir con reintentos: al cambiar de pantalla (lista -> backstage) el ancla
  // del paso nuevo puede tardar un frame. Agotados los reintentos, el paso se
  // salta en vez de dejar el tutorial clavado.
  useLayoutEffect(() => {
    triesRef.current = 0;
    let raf = 0;
    const tick = () => {
      if (measure()) return;
      triesRef.current += 1;
      if (triesRef.current < MAX_TRIES) {
        raf = requestAnimationFrame(tick);
      } else if (i + 1 < total) {
        setI(i + 1);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [measure, i, total]);

  // Seguir el ancla con scroll y resize: el recorte acompana al elemento.
  useEffect(() => {
    const onMove = () => measure();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [measure]);

  // Esc pide confirmacion: salir del tutorial no debe ser un accidente.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setConfirmingExit(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // El foco viaja al tooltip en cada paso: se anuncia y el teclado queda ahi.
  useEffect(() => {
    tipRef.current?.focus({ preventScroll: true });
  }, [i, confirmingExit, box]);

  const goTo = useCallback(
    (next) => {
      setI(next);
      onStep?.(next);
    },
    [onStep]
  );

  const next = useCallback(() => {
    if (i + 1 >= total) return onFinish?.();
    goTo(i + 1);
  }, [i, total, goTo, onFinish]);

  if (!step) return null;

  const tipStyle = box?.mobile
    ? { maxHeight: MOBILE_SHEET_MAX }
    : box
      ? {
          top: box.place === "top" ? undefined : box.top + box.height + TIP_GAP,
          bottom:
            box.place === "top"
              ? window.innerHeight - box.top + TIP_GAP
              : undefined,
          left: Math.min(Math.max(box.left, 12), window.innerWidth - 12),
          maxWidth: Math.min(340, window.innerWidth - 24),
        }
      : undefined;

  return (
    <div
      className="tour-layer"
      role="dialog"
      aria-modal="true"
      aria-label={`Tutorial: ${step.title}`}
    >
      {/* Recorte: el box-shadow gigante oscurece todo menos el ancla. */}
      {box && (
        <div
          className="tour-hole"
          style={{
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height,
          }}
          aria-hidden="true"
        />
      )}

      {/* El tooltip no se pinta hasta tener medidas: sin recorte no se sabe
          donde anclarlo, y un tooltip suelto tapa el ancla sin explicarla. */}
      {box && (
        <div
          ref={tipRef}
          tabIndex={-1}
          className={`tour-tip ${box.mobile ? "is-sheet" : ""} ${
            box.place === "top" && !box.mobile ? "is-top" : ""
          }`}
          style={tipStyle}
        >
          <p className="eyebrow">
            Primeros pasos · {i + 1} de {total}
          </p>
          <h3 className="display mt-0.5 text-base">{step.title}</h3>
          <p className="tour-copy">{step.body}</p>

          <div className="tour-actions">
            <div className="tour-actions-left">
              {i > 0 && (
                <button
                  type="button"
                  onClick={() => goTo(i - 1)}
                  className="btn-ghost !px-3 !py-1.5 text-xs"
                >
                  Atrás
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmingExit(true)}
                className="btn-ghost !px-3 !py-1.5 text-xs"
                data-testid="tour-exit"
              >
                Salir
              </button>
            </div>
            <button
              type="button"
              onClick={next}
              data-testid="tour-next"
              className="btn-primary !px-3 !py-1.5 text-xs"
            >
              {i + 1 >= total ? "Terminar" : "Siguiente"}
            </button>
          </div>
        </div>
      )}

      {/* Ancla ausente y sin pasos siguientes: no hay nada que mostrar, pero
          el tutorial sigue abierto. Se ofrece salir en vez de dejar la
          pantalla oscurecida sin salida. */}
      {!box && missing && i + 1 >= total && (
        <div className="tour-tip is-sheet">
          <h3 className="display text-base">No encontramos esa parte</h3>
          <p className="tour-copy">
            La pantalla cambió. Puedes retomarlo cuando quieras desde
            "Primeros pasos", en el panel.
          </p>
          <div className="tour-actions">
            <button
              type="button"
              onClick={() => onExit?.()}
              className="btn-primary !px-3 !py-1.5 text-xs"
              data-testid="tour-done"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {/* Confirmacion de salida: una pregunta, dos salidas claras. */}
      {confirmingExit && (
        <div className="tour-confirm" role="alertdialog" aria-modal="true">
          <div className="tour-confirm-panel">
            <h3 className="display text-base">¿Quieres salir del tutorial?</h3>
            <p className="tour-copy">
              Puedes retomarlo cuando quieras desde "Primeros pasos", en el
              panel.
            </p>
            <div className="tour-actions">
              <button
                type="button"
                onClick={() => setConfirmingExit(false)}
                className="btn-ghost !px-3 !py-1.5 text-xs"
                data-testid="tour-stay"
              >
                Continuar
              </button>
              <button
                type="button"
                onClick={() => onExit?.()}
                className="btn-primary !px-3 !py-1.5 text-xs"
                data-testid="tour-confirm-exit"
              >
                Salir del tutorial
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
