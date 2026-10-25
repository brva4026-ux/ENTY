/**
 * Comportamiento accesible de un diálogo modal, en un solo sitio.
 *
 * Resuelve las tres cosas que cada modal venía resolviendo a medias:
 *   - Cierre con Escape (antes: solo 2 de 5 modales lo tenían).
 *   - Foco atrapado dentro del diálogo mientras está abierto (antes: el Tab
 *     se iba a la página de fondo, que sigue visible tras el overlay).
 *   - Bloqueo del scroll del fondo (antes: el body seguía scrolleando detrás).
 *
 * Además devuelve el id del título para el `aria-labelledby` del contenedor:
 * sin él el lector anuncia "diálogo" sin decir de qué.
 *
 * Uso:
 *   const { dialogRef, titleId } = useDialogA11y({ open, onClose });
 *   <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
 *     <h3 id={titleId}>Título</h3>
 */
import { useEffect, useId, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useDialogA11y({ open = true, onClose }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  // `onClose` suele ser una lambda nueva en cada render; guardarlo en un ref
  // evita que el efecto se desmonte y vuelva a montar en cada render (lo que
  // re-dispararía el foco y el bloqueo de scroll).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const node = dialogRef.current;
    const previousFocus = document.activeElement;

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (e.key !== "Tab" || !node) return;

      const items = Array.from(node.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !node.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    // Scroll lock: se compensa el ancho de la barra de scroll para que el
    // fondo no dé el salto lateral al desaparecer.
    const { body } = document;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    body.style.overflow = "hidden";
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

    // Foco inicial: el primer control útil, o el propio diálogo si no hay.
    const focusTimer = setTimeout(() => {
      if (!node) return;
      const items = Array.from(node.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null
      );
      (items[0] ?? node).focus?.();
    }, 30);

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      clearTimeout(focusTimer);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
      // Devolver el foco a quien abrió el diálogo: sin esto el foco se queda
      // en el body y el usuario de teclado pierde su posición.
      if (previousFocus instanceof HTMLElement) previousFocus.focus?.();
    };
  }, [open]);

  return { dialogRef, titleId };
}

export default useDialogA11y;
