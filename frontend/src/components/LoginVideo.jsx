import { useEffect, useRef, useState } from "react";

/**
 * Video de fondo de la pantalla de ingreso.
 *
 * El clip no es material de stock: se sintetiza con la paleta y los motivos
 * de la marca (negro #0B0B0F, destellos morados, verde y rosa neón, el grid
 * del QR de la boleta y la estrella del logo). Ver
 * `scripts/generate_login_video.py` y `frontend/public/brand/guidelines.html`.
 *
 * Se sirve en webm (VP9) y mp4 (H.264) para cubrir Safari/iOS, con un póster
 * JPEG para que el primer pintado no sea negro. Si el navegador no puede
 * reproducirlo, si el usuario pidió menos movimiento o si ahorra datos, el
 * componente no pinta nada y deja ver el fondo CSS (LoginAurora) que va
 * debajo: la pantalla nunca queda vacía.
 */
export function LoginVideo() {
  const ref = useRef(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const prefersReduced =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const appReduced = document.documentElement.dataset.motion === "reduce";
    // Ahorro de datos (móvil con plan medido): no descargamos el video.
    const saveData = navigator.connection?.saveData === true;
    // Tema claro: el clip es de marca oscura y sobre crema desentona; ahí manda
    // el fondo CSS claro, así que ni lo bajamos.
    const lightTheme = document.documentElement.dataset.theme === "light";
    if (prefersReduced || appReduced || saveData || lightTheme) return;
    setEnabled(true);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    // Algunos navegadores ignoran autoPlay hasta que el elemento es visible.
    const p = el.play?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div className="auth-video" aria-hidden="true">
      <video
        ref={ref}
        className="auth-video-el"
        poster="/media/login-bg-poster.jpg"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        onError={() => setEnabled(false)}
      >
        <source src="/media/login-bg.webm" type="video/webm" />
        <source src="/media/login-bg.mp4" type="video/mp4" />
      </video>
      {/* Velo: baja el video a atmósfera y asegura contraste de la tarjeta
          encima, tanto en el centro como en las esquinas. */}
      <span className="auth-video-scrim" />
    </div>
  );
}
