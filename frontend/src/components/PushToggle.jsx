/**
 * PushToggle: switch "Avisarme cuando abran puertas" del escáner.
 * Estados: carga (skeleton), oculto (sin soporte o backend sin VAPID),
 * activado/desactivado. Persistencia: la suscripción vive en el navegador
 * y en push_subscriptions; localStorage guarda solo la preferencia para
 * re-suscribir automáticamente tras un reinicio del service worker.
 */
import { useEffect, useState } from "react";
import {
  disablePush,
  enablePush,
  fetchPushConfig,
  getCurrentSubscription,
  pushSupported,
} from "../lib/push";
import { useUI } from "../lib/ui";

const PREF_KEY = "tf_push_enabled";

export function PushToggle({ venueId }) {
  const ui = useUI();
  const [supported, setSupported] = useState(true);
  const [serverEnabled, setServerEnabled] = useState(true);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!pushSupported()) {
          if (alive) setSupported(false);
          return;
        }
        const config = await fetchPushConfig();
        if (!alive) return;
        setServerEnabled(!!config.enabled);
        const sub = await getCurrentSubscription();
        if (alive) {
          setOn(!!sub && localStorage.getItem(PREF_KEY) === "1");
        }
      } catch {
        if (alive) setServerEnabled(false);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      if (on) {
        await disablePush();
        localStorage.removeItem(PREF_KEY);
        setOn(false);
        ui.info("Avisos desactivados");
      } else {
        await enablePush(venueId);
        localStorage.setItem(PREF_KEY, "1");
        setOn(true);
        ui.success("Te avisaremos cuando abran puertas 🚪");
      }
    } catch (e) {
      ui.error(e.message || "No se pudieron cambiar los avisos");
    } finally {
      setBusy(false);
    }
  }

  if (!ready || !supported || !serverEnabled || !venueId) return null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-zinc-200">
          Avisarme cuando abran puertas
        </p>
        <p className="text-2xs text-zinc-500">
          Notificación push, aunque la app esté cerrada
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Avisarme cuando abran puertas"
        onClick={toggle}
        disabled={busy}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200 ${
          on ? "bg-emerald-600" : "bg-zinc-700"
        } ${busy ? "opacity-60" : ""}`}
      >
        <span
          className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
            on ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </div>
  );
}
