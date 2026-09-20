/**
 * Cifras que cuentan hasta su valor: la microinteracción que hace que un
 * dashboard se sienta "vivo" (Stripe/Linear). El conteo es rAF con easing
 * expo-out: arranca rápido y se asienta — nunca lineal ni mareante.
 *
 * Respeta prefers-reduced-motion (salta directo al valor final) y anima
 * DESDE el valor anterior cuando el dato cambia en caliente (refresh del
 * reporte): la cifra no salta, transita.
 */
import { useEffect, useRef, useState } from "react";

const prefersReduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function useCountUp(target, { duration = 900, delay = 0 } = {}) {
  const [value, setValue] = useState(() => (prefersReduced() ? target : 0));
  const fromRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (prefersReduced()) {
      setValue(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    const start = performance.now() + delay;
    const ease = (t) => 1 - Math.pow(1 - t, 4);
    const tick = (now) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      setValue(from + (target - from) * ease(t));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration, delay]);

  return value;
}
