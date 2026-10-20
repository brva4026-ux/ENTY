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
const SKIP_PREFIX = ["/bouncer", "/t"];

export function CookieNotice() {
  const location = useLocation();
  const nav = useNavigate();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (SKIP_PREFIX.some((p) => location.pathname.startsWith(p))) return;
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
    <div className="px-2 pt-2 sm:px-3 sm:pt-3">
      <div
        role="note"
        aria-label="Aviso de cookies"
        className="cookie-notice mx-auto flex max-w-3xl flex-col gap-1.5 rounded-xl border border-zinc-700/60 bg-zinc-900/95 px-3 py-2 text-2xs leading-snug text-zinc-200 shadow-lg sm:flex-row sm:items-center sm:gap-3 sm:px-4 sm:py-3 sm:text-xs sm:leading-relaxed"
      >
        <p className="min-w-0 flex-1">
          Solo lo necesario para tu sesión y el modo sin conexión. Sin cookies
          de publicidad ni analítica.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {/* Objetivo tactil AA (WCAG 2.5.8, 24px): un <button> es
              inline-block, no inline, asi que no aplica la exencion de enlace
              dentro de un parrafo; el renglon de 20px no llega. El padding
              vertical da el area sin agrandar el texto. */}
          <button
            type="button"
            onClick={() => {
              close();
              nav("/cookies");
            }}
            className="py-1 underline decoration-zinc-600 underline-offset-2 hover:text-white"
          >
            Aviso de cookies
          </button>
          <button
            type="button"
            onClick={close}
            className="btn-ghost !px-3 !py-1.5 text-xs"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
}
