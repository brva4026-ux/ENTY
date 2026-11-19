/**
 * Que seccion se esta leyendo y cuanto se lleva de la pagina.
 *
 * Devuelve `active` (id de la seccion cuyo encabezado esta mas cerca del borde
 * superior, sin haberse ido por arriba), `progress` (0..1) y `scrolled` (si la
 * pagina ya paso el primer tramo). Sirve al indice de la portada: el enlace de
 * la seccion visible se marca solo, sin que el usuario tenga que adivinar donde
 * esta.
 *
 * La seccion activa se decide por el ultimo encabezado que cruzo una linea al
 * 25% del viewport, no por interseccion: es la misma cuenta que hace un lector
 * con el dedo, y no depende de que el bloque entero quepa en pantalla.
 *
 * Un solo `scroll` pasivo con `requestAnimationFrame` compartido por los dos
 * valores: dos listeners para lo mismo costarian el doble en el scroll, que es
 * justo donde se nota.
 */
import { useEffect, useState } from "react";

export default function useSectionSpy(ids) {
  const [active, setActive] = useState("");
  const [progress, setProgress] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (!sections.length) return;

    let raf = 0;

    const measure = () => {
      raf = 0;
      const line = (window.innerHeight || 0) * 0.25;
      let current = "";
      for (const el of sections) {
        if (el.getBoundingClientRect().top <= line) current = el.id;
      }
      // Al llegar al fondo, la ultima seccion gana aunque su encabezado no
      // haya cruzado la linea: si no, el indice diria "Funciones" con la
      // pagina ya en la linea de confianza.
      const doc = document.documentElement;
      const max = doc.scrollHeight - (window.innerHeight || 0);
      const y = window.scrollY || 0;
      if (max > 0 && y >= max - 2) current = sections[sections.length - 1].id;
      setActive(current);
      setProgress(max > 0 ? Math.min(1, Math.max(0, y / max)) : 0);
      setScrolled(y > 24);
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ids]);

  return { active, progress, scrolled };
}
