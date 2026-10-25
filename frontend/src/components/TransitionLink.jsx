import { Link, useNavigate } from "react-router-dom";
import { withViewTransition } from "../lib/viewTransition";

/**
 * Link que cruza con View Transition.
 *
 * `withViewTransition` (lib/viewTransition.js) envuelve la navegación, pero el
 * `<Link>` de react-router navega por su cuenta y la API no llega a verlo. Se
 * intercepta el clic: se cancela la navegación del Link y se hace la misma con
 * la transición. Los casos que NO deben interceptarse se dejan pasar tal cual
 * (el Link navega normal, sin transición):
 *
 *   - clic con modificador o botón del medio: abrir en pestaña nueva;
 *   - `target="_blank"`: idem;
 *   - el onClick del consumidor llamó `preventDefault` (dueño de la decisión).
 *
 * El fallback (navegador sin soporte o movimiento reducido) vive en
 * `withViewTransition`: navega directo.
 */
export default function TransitionLink({
  to,
  onClick,
  replace,
  state,
  target,
  ...rest
}) {
  const nav = useNavigate();

  const handleClick = (event) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (target && target !== "_self") return;
    // `to` puede ser un objeto con búsqueda/hash: se pasa entero a nav().
    event.preventDefault();
    withViewTransition(() => nav(to, { replace, state }));
  };

  return (
    <Link
      to={to}
      onClick={handleClick}
      replace={replace}
      state={state}
      target={target}
      {...rest}
    />
  );
}
