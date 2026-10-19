/**
 * Banner de estado offline: aparece en cuanto el navegador pierde conexión y
 * desaparece al recuperarla. Crítico en la puerta (wifi de discotecas), donde
 * el portero debe saber de inmediato que sus validaciones pueden fallar.
 */
import { useEffect, useState } from "react";

export function OfflineBanner() {
  const [offline, setOffline] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine === false
  );

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="alert"
      // El banner se ancla a top:0; con viewport-fit=cover cae bajo la isla
      // dinamica. El inset lo empuja al area segura (mismo patron que
      // Layout.jsx con la barra inferior).
      style={{ paddingTop: "calc(0.375rem + env(safe-area-inset-top))" }}
      className="offline-in fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-xs font-bold text-amber-950"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
        <path d="M1 1l22 22M16.7 11.7a7 7 0 0 0-9.4 0M8.5 15a3.5 3.5 0 0 1 7 0M12 19h.01" />
      </svg>
      Sin conexión: los escaneos no se guardarán hasta que vuelva la red
    </div>
  );
}
