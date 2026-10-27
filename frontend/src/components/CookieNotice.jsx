import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * Aviso de cookies (informativo, no bloqueante).
 *
 * El aviso de cookies (documento `cookies`) es explicito: lo unico que la app
 * guarda en el navegador es lo estrictamente necesario (sesion, tema, cache
 * offline, push), y conforme al criterio de la autoridad eso NO exige
 * consentimiento — exige INFORMACION. Por eso esta barra no es un dialogo
 * bloqueante: informa y se cierra una vez.
 *
 * - Se recuerda en localStorage bajo el numero de version del aviso: si los
 *   documentos legales cambian de razon para re-informar, basta subir
 *   NOTICE_VERSION y vuelve a aparecer.
 * - Sin acceso a localStorage (navegador en modo privado restrico) se muestra
 *   y se ignora al cerrarla: un aviso que no puede recordarse no debe
 *   bloquear nada.
 * - No aparece en el escaner de puerta (pantalla de trabajo a una mano) ni en
 *   la boleta publica del invitado (su zona de lectura es intocable; los
 *   enlaces legales ya estan ahi).
 */

const NOTICE_VERSION = "1.1";
const STORE_KEY = "tf_cookie_notice";
const SKIP_PREFIX = ["/bouncer"];

/**
 * La boleta publica es `/t/:token`. Se comprueba por segmento exacto y no con
 * un prefijo suelto `/t`: `startsWith("/t")` tambien capturaba `/terminos`,
 * `/terminos-boleta` y `/tratamiento-datos`, y el aviso desaparecia en las
 * paginas que precisamente lo citan.
 */
function isPublicTicket(pathname) {
  return pathname === "/t" || pathname.startsWith("/t/");
}

export function CookieNotice() {
  const location = useLocation();
  const nav = useNavigate();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (SKIP_PREFIX.some((p) => location.pathname.startsWith(p))) return;
    if (isPublicTicket(location.pathname)) return;
    try {
      setVisible(localStorage.getItem(STORE_KEY) !== NOTICE_VERSION);
    } catch {
      setVisible(true);
    }
  }, [location.pathname]);

  if (!visible) return null;

  const close = () => {
    setVisible(false);
    try {
      localStorage.setItem(STORE_KEY, NOTICE_VERSION);
    } catch {
      // Sin persistencia (navegador restricto): que el aviso vuelva a salir en
      // la próxima visita en vez de romper el cierre.
    }
  };

  return (
    <div
      role="note"
      aria-label="Aviso de cookies"
      className="cookie-notice fixed inset-x-0 bottom-0 z-40 flex flex-row items-center gap-2 border-t border-zinc-700/60 bg-zinc-900/95 px-4 py-2.5 text-[11px] leading-tight text-zinc-200 shadow-lg sm:inset-x-3 sm:bottom-3 sm:mx-auto sm:max-w-3xl sm:gap-3 sm:rounded-xl sm:border sm:py-3 sm:text-xs sm:leading-relaxed"
    >
      <p className="min-w-0 flex-1">
        Esta app guarda en tu navegador lo necesario para la sesión y el modo
        sin conexión de la puerta. No hay cookies de publicidad ni de
        analítica; por eso no pedimos consentimiento: lo informamos.
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {/* En movil solo queda "Entendido": el enlace legal sigue estando en
            el pie y en /cookies, y dejar dos botones alargaba la barra. Los
            dos cumplen 44px de objetivo tactil. */}
        <button
          type="button"
          onClick={() => {
            close();
            nav("/cookies");
          }}
          className="hidden min-h-11 items-center underline decoration-zinc-600 underline-offset-2 hover:text-white sm:inline-flex"
        >
          Aviso de cookies
        </button>
        <button
          type="button"
          onClick={close}
          className="btn-ghost min-h-11 !px-3 text-xs"
        >
          Entendido
        </button>
      </div>
    </div>
  );
}
