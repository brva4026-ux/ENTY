import { useEffect, useRef, useState } from "react";
import { Logo } from "./Brand";

/** Splash de marca: se muestra mientras AuthProvider restaura la sesión
 *  (token -> /auth/me). Evita el flash de la pantalla de login en cada
 *  apertura de la PWA — el gesto distintivo de una app nativa.
 *
 *  Uso: {booting && <SplashScreen />} en el árbol principal.
 */
export function SplashScreen() {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    // Cap de seguridad: aunque /auth/me se cuelgue, el splash no vive más
    // de 3s. Se limpia en unmount para no filtrar el timer en tests.
    timerRef.current = setTimeout(() => setExiting(true), 3000);
    return () => clearTimeout(timerRef.current);
  }, []);

  return (
    <div
      className={`flex h-[100dvh] flex-col items-center justify-center bg-zinc-950 ${
        exiting ? "splash-exit" : ""
      }`}
      aria-hidden="true"
    >
      <span className="splash-logo">
        <Logo size="lg" />
      </span>
      <span className="mt-3 text-xs font-medium tracking-[0.2em] text-zinc-600 uppercase">
        Accesos que se validan
      </span>
    </div>
  );
}
