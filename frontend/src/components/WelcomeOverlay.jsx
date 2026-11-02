import { useEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "../lib/motion";

/**
 * Bienvenida personalizada tras un login correcto.
 *
 * Antes, el exito eran 260 ms de un boton que decia "Listo" y un corte seco al
 * panel: la persona no alcanzaba a registrar que su click habia entrado. Esta
 * capa nombra a quien entro y da una espera visible mientras el resto del
 * arranque termina.
 *
 * Tres reglas que la hacen honesta y no un adorno:
 *
 *  1. La barra es REAL. Avanza mientras la promesa de login sigue viva y solo
 *     se completa cuando termina. No es un temporizador decorativo que se llena
 *     solo: si el backend tarda, la barra espera con el usuario.
 *  2. Nada de "99% y se queda". El avance se acerca asintoticamente a un techo
 *     y el salto a 100 lo da el evento real (exito). Si falla, la capa se cierra
 *     y el error aparece en el formulario, que es donde se corrige.
 *  3. Con movimiento reducido no hay animacion de entrada ni de check: la
 *     tarjeta aparece, la barra avanza y se navega. La preferencia manda.
 *
 * No se puede cerrar a proposito: es un estado de transito, no un dialogo. En
 * cuanto hay error o navegacion, desaparece sola.
 */

/** Primer nombre para el saludo: "Ana Maria Lopez" -> "Ana". */
function firstNameOf(user) {
  const full = (user?.full_name || "").trim();
  if (full) return full.split(/\s+/)[0];
  // Sin nombre cargado: el usuario o la parte local del correo saludan igual.
  return user?.username || (user?.email || "").split("@")[0] || "";
}

export function WelcomeOverlay({ user, done }) {
  const [progress, setProgress] = useState(0);
  const timer = useRef(0);
  // `done` se lee dentro del bucle via ref: si estuviera en las deps, cada
  // cambio de exito reiniciaria la animacion desde cero.
  const doneRef = useRef(done);
  doneRef.current = done;

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
      current += (92 - current) * 0.055;
      setProgress(current);
      timer.current = window.setTimeout(tick, 60);
    };
    timer.current = window.setTimeout(tick, 60);
    return () => window.clearTimeout(timer.current);
  }, []);

  // El exito completa la barra; el padre navega despues.
  useEffect(() => {
    if (done) setProgress(100);
  }, [done]);

  const pct = Math.round(progress);
  const name = firstNameOf(user);

  return (
    <div className="welcome-scrim">
      <div
        className="welcome-card"
        role="status"
        aria-live="polite"
        aria-busy={!done}
      >
        <span className="welcome-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
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
          <span className="welcome-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
