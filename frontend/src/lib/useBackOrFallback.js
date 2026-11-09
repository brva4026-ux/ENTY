import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { withViewTransition } from "./viewTransition";

/**
 * "Volver" con destino garantizado (Ley de Jakob: el botón hace lo que dice).
 *
 * `navigate(-1)` a secas es un botón muerto en un deep-link: quien abre
 * `/evento/:id` desde un enlace de WhatsApp (el caso más común de esa pantalla)
 * no tiene historial de la app detrás, así que el "Volver" no lleva a ninguna
 * parte. Se comprueba el índice que react-router guarda en `history.state`
 * (`idx`): si es > 0 hay a dónde volver; si no, se cae al destino canónico.
 *
 * @param {string} fallback ruta a la que ir cuando no hay historial
 * @returns {() => void} callback listo para un onClick
 */
export default function useBackOrFallback(fallback) {
  const nav = useNavigate();
  return useCallback(() => {
    const idx = window.history.state?.idx;
    if (typeof idx === "number" && idx > 0) {
      withViewTransition(() => nav(-1));
    } else {
      withViewTransition(() => nav(fallback, { replace: true }));
    }
  }, [nav, fallback]);
}
