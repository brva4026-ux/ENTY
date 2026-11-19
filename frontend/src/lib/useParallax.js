/**
 * Desplazamiento relativo al scroll (parallax) para la atmosfera del hero.
 *
 * El fondo se mueve a una fraccion del scroll, no a la misma: es lo que da
 * profundidad sin convertirse en un segundo scroll. La fraccion es pequena a
 * proposito (0.15) y el recorrido se acota, porque un parallax que se nota es
 * un parallax que marea.
 *
 * Se escribe una custom property (`--parallax-y`) y el CSS decide que la usa y
 * como: el JS no toca `transform`, asi el elemento puede seguir animando su
 * entrada sin que las dos escrituras se peleen.
 *
 * Acepta un `ref` externo (para reutilizar un nodo que ya existe, como la
 * atmosfera de la raiz) o devuelve el suyo si no se le pasa ninguno.
 *
 * Solo mide mientras el elemento esta en pantalla: fuera de vista no gasta un
 * frame. Con movimiento reducido o red lenta no se monta el listener.
 */
import { useEffect, useRef } from "react";

export default function useParallax({
  ref: externalRef,
  factor = 0.15,
  max = 120,
  enabled = true,
} = {}) {
  const ownRef = useRef(null);
  const ref = externalRef ?? ownRef;

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el || typeof window === "undefined") return;

    let raf = 0;
    let visible = true;

    const write = () => {
      raf = 0;
      const y = Math.min(max, Math.max(0, (window.scrollY || 0) * factor));
      el.style.setProperty("--parallax-y", `${y.toFixed(1)}px`);
    };

    const schedule = () => {
      if (visible && !raf) raf = requestAnimationFrame(write);
    };

    // Sin IntersectionObserver solo se mide igual: el coste es una resta por
    // frame, pero el observer evita incluso eso cuando el hero ya salio.
    let io = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        ([entry]) => {
          visible = entry.isIntersecting;
          if (visible) schedule();
        },
        { rootMargin: "120px 0px" },
      );
      io.observe(el);
    }

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    write();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      io?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      el.style.removeProperty("--parallax-y");
    };
  }, [ref, factor, max, enabled]);

  return ref;
}
