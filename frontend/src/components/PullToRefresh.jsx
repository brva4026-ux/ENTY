import { useRef, useState } from "react";

/** Pull-to-refresh con el patrón nativo (iOS/Android): arrastrar hacia abajo
 *  desde el tope revela un spinner con resistancia y, al superar el umbral,
 *  dispara la recarga. Solo actúa en pantallas táctiles y solo cuando el
 *  scroll ya está en el tope — el scroll normal no se ve afectado.
 *
 *  Props: onRefresh (async), children.
 */
const THRESHOLD = 70;
const MAX_PULL = 120;

export function PullToRefresh({ onRefresh, children }) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(null);
  const decided = useRef(false);

  function onStart(e) {
    if (!e.isPrimary || window.scrollY > 0 || refreshing) return;
    // Solo toques: el mouse de escritorio no debe activarlo.
    if (e.pointerType !== "touch") return;
    startY.current = e.clientY;
    decided.current = false;
  }

  function onMove(e) {
    if (startY.current == null || refreshing) return;
    const dy = e.clientY - startY.current;
    if (dy <= 0) {
      setPull(0);
      return;
    }
    // Resistencia: cada px adicional cuesta más (como el overscroll nativo).
    setPull(Math.min(MAX_PULL, Math.round(dy * 0.45)));
    if (!decided.current && pull >= THRESHOLD) {
      decided.current = true;
      if (navigator.vibrate) navigator.vibrate(10);
    }
  }

  async function onEnd() {
    const shouldRefresh = startY.current != null && pull >= THRESHOLD && !refreshing;
    startY.current = null;
    if (!shouldRefresh) {
      setPull(0);
      return;
    }
    setRefreshing(true);
    setPull(THRESHOLD);
    try {
      await onRefresh?.();
    } finally {
      setRefreshing(false);
      setPull(0);
    }
  }

  const spinnerVisible = refreshing || pull > 8;
  const spin = refreshing || pull >= THRESHOLD;

  return (
    <div
      onTouchStart={onStart}
      onTouchMove={onMove}
      onTouchEnd={onEnd}
      onTouchCancel={onEnd}
      className="touch-pan-y select-none"
    >
      <div
        className="flex items-center justify-center overflow-hidden transition-[height] duration-200 ease-out"
        style={{ height: refreshing ? 52 : pull }}
      >
        {spinnerVisible && (
          <svg
            className={`ptr-spinner h-6 w-6 ${spin ? "" : "opacity-60"}`}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        )}
      </div>
      {children}
    </div>
  );
}
