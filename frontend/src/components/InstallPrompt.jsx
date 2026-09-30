import { useEffect, useState } from "react";
import { Logo } from "./Brand";

/** Tarjeta de instalación de la PWA.
 *  - Android/Chrome: captura beforeinstallprompt y ofrece el install nativo.
 *  - iOS: instrucciones exactas (Compartir -> Añadir a inicio).
 *  - Ya instalada (display-mode: standalone) no se muestra nunca.
 */
const DISMISS_KEY = "tf_install_dismissed";

export function InstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [isIOS, setIsIOS] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === "1"
  );
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const standaloneNow =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    setStandalone(standaloneNow);

    const ua = window.navigator.userAgent;
    setIsIOS(/iphone|ipad|ipod/i.test(ua));

    const onPrompt = (e) => {
      e.preventDefault();
      setDeferred(e);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (standalone || installed || dismissed) return null;

  async function install() {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  }

  const available = deferred && !isIOS;
  if (!available && !isIOS) return null;

  return (
    <div className="card animate-rise relative overflow-hidden p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">
          <Logo />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">
            Instala Tickelot en tu teléfono
          </p>
          {available ? (
            <>
              <p className="mt-0.5 text-xs text-zinc-400">
                Ábrelo como app, sin barra del navegador y con ícono propio.
              </p>
              <button onClick={install} className="btn-primary mt-3 !px-4 !py-2 text-sm">
                Instalar ahora
              </button>
            </>
          ) : (
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
              En iPhone: toca <span className="font-semibold text-zinc-200">Compartir</span> ⬆️ y
              elige <span className="font-semibold text-zinc-200">Añadir a pantalla de inicio</span>.
            </p>
          )}
        </div>
        <button
          onClick={dismiss}
          aria-label="No volver a mostrar"
          className="shrink-0 rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
