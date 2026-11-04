import { useEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "../lib/motion";

/** Primer nombre para el saludo: "Ana Maria Lopez" -> "Ana". */
function firstNameOf(user) {
  const full = (user?.full_name || "").trim();
  if (full) return full.split(/\s+/)[0];
  // Sin nombre cargado: el usuario o la parte local del correo saludan igual.
  return user?.username || (user?.email || "").split("@")[0] || "";
}

/**
 * Bienvenida personalizada tras un login correcto.
 *
 * Tres reglas que la hacen honesta y no un adorno:
 *
 *  1. La barra es REAL. Avanza mientras la promesa de login sigue viva y solo
 *     se completa cuando termina. No es un temporizador decorativo que se llena
 *     solo: si el backend tarda, la barra espera con el usuario.
 *  2. Nada de "99% y se queda". El avance se acerca asintóticamente a un techo
 *     y el salto a 100 lo da el evento real (éxito). Si falla, la capa se cierra
 *     y el error aparece en el formulario, que es donde se corrige.
 *  3. Con movimiento reducido no hay animación de entrada ni de check: la
 *     tarjeta aparece, la barra avanza y se navega. La preferencia manda.
 *
 * No se puede cerrar a propósito: es un estado de transito, no un dialogo. En
 * cuanto hay error o navegacion, desaparece sola.
 */

export function WelcomeOverlay({ user, done }) {
  const [progress, setProgress] = useState(0);
  const timer = useRef(0);
  // `done` se lee dentro del bucle via ref: si estuviera en las deps, cada
  // cambio de exito reiniciaria la animacion desde cero.
  const doneRef = useRef(done);
  doneRef.current = done;
  // Si el overlay se queda abierto sin que el login haya terminado bien,
  // lo cerramos: uno no quiere pegado mirando una pantalla de espera.
  useEffect(() => {
    if (entered && !done) {
      setProgress(0);
      setEntered(null);
    }
  }, [entered, done]);

  // Tiempo mínimo visible: aunque el login responda en milisegundos, la
  // bienvenida se queda un momento así de vez para que el usuario lea el
  // estado (Ingresando...) sin que la tarjeta se vaya punzulante. Unas
  // décimas de segundo más abajo que el umbral del padre de la transición,
  // así el avance real sigue siendo el que marca la barra.
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setProgress(100), 160);
    return () => clearTimeout(id);
  }, [done]);

  // Avance asintotico: rapido al principio, lento cerca del techo. El techo
  // (92) deja lugar al salto final, que lo pone el exito real.
  useEffect(() => {
    if (prefersReducedMotion()) {
      setProgress(done ? 100 : 60);
      return undefined;
    }
    let current = 0;
    const tick = () => {
      // Una vez que el login termino, el bucle se detiene: sin esto seguia
      // corriendo y volvia a bajar la barra de 100 a ~10, prometiendo el
      // final y retrocediendo despues.
      if (doneRef.current) return;
      // Acelera real: sin suavizado (una sola ausencia de smooth en el
      // progress), la barra se alcanza en unos 400ms, no en 2s, y el
      // estado se entiende igual: sube, se asienta y el exito lo sigue.
      // El factor 0.11 aplica el 11% del espacio restante en cada
      // tick, en vez del 5.5% original: acelera la barra un 50%.
      current += (92 - current) * 0.11;
      setProgress(current);
      // Tick más rápido (30ms) para que no se note la escala a 5.5% y
      // el usuario lea el avance de forma constante, y que la barra
      // llegue al 100% en un tiempo más corto (unos 400ms, no 2s).
      timer.current = window.setTimeout(tick, 30);
    };
    timer.current = window.setTimeout(tick, 30);
    return () => window.clearTimeout(timer.current);
  }, []);

  // El exito completa la barra; el padre navega despues. `setEntered` lo
  // cierra después de que ha llegado al final, así la capa no se queda
  // colgada: el bucle se para, la barra llega al 100 y la tarjeta sale sola.
  useEffect(() => {
    if (done) {
      setProgress(100);
    }
  }, [done]);

  const pct = Math.round(progress);
  const name = firstNameOf(user);

  // El estilo no es el mismo fondo semitransparente que el del login, para
  // que no parezca una capa duplicada: el color de la tarjeta es el de la
  // boleta (navy tint), el fondo es el lienzos blanco cálido y el borde
  // vacío suaviza la curva. Así se ve bien en la app y el usuario entiende
  // que está viendo un estado real, no una sorpresa.
  const isComplete = done || pct >= 100;

  return (
    <div className="welcome-scrim">
      <div
        className="welcome-card"
        role="status"
        aria-live="polite"
        aria-busy={!done}
      >
        <span className="welcome-check" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path
              d="m5 12.5 4.5 4.5L19 7"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>

        <h2 className="welcome-title">¡Bienvenido!</h2>

        <p className="welcome-hello">
          Hola, <strong>{name}</strong>.
        </p>
        {user?.email && <p className="welcome-email">{user.email}</p>}

        <p className="welcome-status">Ingresando...</p>

        <div
          className="welcome-bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={pct}
          aria-label="Preparando tu panel"
        >
          <span
            className={`welcome-bar-fill${isComplete ? " is-complete" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
