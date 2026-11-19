/**
 * Un disparador que se abre UNA vez, cuando el elemento asoma.
 *
 * Para las cifras que cuentan: el numero debe arrancar cuando el ojo llega,
 * no al cargar la pagina (si no, la animacion ocurre fuera de pantalla y nadie
 * la ve). Se mide con `getBoundingClientRect` por scroll, igual que el
 * revelado, porque un `IntersectionObserver` no avisa de un bloque que salto
 * de "debajo" a "encima" del viewport de golpe.
 *
 * Con `enabled` en false (movimiento reducido o red lenta) devuelve `true`
 * desde el primer render: el valor final se pinta sin animacion.
 */
import { useEffect, useState } from "react";

export default function useInViewOnce(ref, { enabled = true, line = 0.9 } = {}) {
  const [seen, setSeen] = useState(!enabled);

  useEffect(() => {
    if (!enabled) {
      setSeen(true);
      return;
    }
    const el = ref.current;
    if (!el || typeof window === "undefined") return;

    let raf = 0;
    const check = () => {
      raf = 0;
      const limit = (window.innerHeight || 0) * line;
      if (el.getBoundingClientRect().top < limit) {
        setSeen(true);
        window.removeEventListener("scroll", schedule);
        window.removeEventListener("resize", schedule);
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, enabled, line]);

  return seen;
}
