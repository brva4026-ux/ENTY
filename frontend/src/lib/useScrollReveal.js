import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./motion";

/**
 * Revela al entrar en pantalla.
 *
 * Devuelve `rootRef` (va en la raiz de la pantalla) y `enabled`. Cuando el
 * movimiento esta permitido, el CSS esconde los bloques marcados con
 * `[data-reveal]` y este hook les pone `is-in` al asomar: la entrada ocurre
 * donde el ojo la ve, no toda al cargar (lo que esta bajo el pliegue se
 * animaba sin que nadie lo mirara).
 *
 * Se mide con `getBoundingClientRect` en un `requestAnimationFrame` por
 * evento de scroll, en vez de con `IntersectionObserver`. El observer es mas
 * barato pero solo avisa cuando la interseccion CAMBIA: un bloque que salta de
 * "debajo" a "encima" del viewport de una sola vez (un ancla, un deep-link
 * `#seccion`, una recarga ya desplazada, un scroll muy rapido) nunca intersecta
 * y se quedaria invisible para siempre. Midiendo posicion se cubren todos esos
 * casos, y solo se recorren los bloques aun pendientes, asi que el coste es
 * minimo.
 *
 * Dos guardas para no dejar contenido invisible:
 *  - Movimiento reducido (SO o preferencia de la app) -> `enabled` es false, no
 *    se pone la clase que esconde y todo queda visible desde el primer frame.
 *  - El estado oculto vive SOLO bajo `.lp-anim`; si el efecto no llegara a
 *    correr, el contenido no depende de el para verse.
 *
 * `key` re-arma la busqueda cuando cambia el contenido (p. ej. la cartelera
 * que llega async): las filas nuevas se observan al aparecer.
 */
export default function useScrollReveal(key) {
  const rootRef = useRef(null);
  const [enabled] = useState(
    () => !prefersReducedMotion() && typeof window !== "undefined",
  );

  useEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    if (!root) return;

    let pending = Array.from(root.querySelectorAll("[data-reveal]"));
    if (!pending.length) return;

    let raf = 0;

    const detach = () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };

    const check = () => {
      raf = 0;
      // 88% de la altura: el bloque se revela al entrar por el borde inferior,
      // no cuando ya esta centrado (asi la animacion se lee como parte del
      // scroll). Un `top` negativo tambien entra aqui: es lo que quedo arriba.
      const line =
        (window.innerHeight || document.documentElement.clientHeight) * 0.88;
      const rest = [];
      for (const el of pending) {
        if (el.getBoundingClientRect().top < line) el.classList.add("is-in");
        else rest.push(el);
      }
      pending = rest;
      if (!pending.length) detach();
    };

    function schedule() {
      if (!raf) raf = requestAnimationFrame(check);
    }

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return detach;
  }, [enabled, key]);

  return { rootRef, enabled };
}
