/**
 * Avisos push de ESTE dispositivo.
 *
 * El estado que manda es el del servidor: permiso del navegador, suscripción
 * local y registro del endpoint exacto para la cuenta y la organización. Un
 * localStorage con "1" no acredita que el aviso llegue.
 */
import { useCallback, useEffect, useState } from "react";
import {
  disablePush,
  enablePush,
  fetchPushConfig,
  fetchPushStatus,
  getCurrentSubscription,
  pushPermission,
  pushSupported,
  retryPushRegistration,
  sendTestPush,
} from "../lib/push";
import { useUI } from "../lib/ui";

const EMPTY = {
  ready: false,
  supported: true,
  serverEnabled: true,
  permission: "default",
  subscribed: false,
  registered: false,
  endpoint: null,
  registeredAt: null,
  device: null,
  error: "",
};

export function PushToggle({ venueId }) {
  const ui = useUI();
  const [state, setState] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState(null);

  const refresh = useCallback(async () => {
    if (!venueId) {
      setState({
        ...EMPTY,
        ready: true,
        supported: false,
        serverEnabled: false,
        error: "No hay una organización activa para asociar los avisos.",
      });
      return;
    }
    if (!pushSupported()) {
      setState({
        ...EMPTY,
        ready: true,
        supported: false,
        permission: "unsupported",
        serverEnabled: false,
      });
      return;
    }
    try {
      const config = await fetchPushConfig();
      const permission = pushPermission();
      const sub = await getCurrentSubscription();
      const endpoint = sub?.endpoint || null;
      const status = await fetchPushStatus(venueId, {
        endpoint,
        permission,
        subscribed: Boolean(sub),
      });
      setState({
        ready: true,
        supported: true,
        serverEnabled: Boolean(config.enabled),
        permission: status.permission,
        subscribed: status.subscribed,
        registered: status.registered,
        endpoint,
        registeredAt: status.registered_at,
        device: status.device,
        error: "",
      });
    } catch (e) {
      setState({
        ...EMPTY,
        ready: true,
        serverEnabled: false,
        error: e.message || "No pudimos comprobar el estado de los avisos.",
      });
    }
  }, [venueId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!alive) return;
      await refresh();
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  async function activate() {
    if (busy) return;
    setBusy(true);
    setTestMsg(null);
    try {
      // El permiso se pide SOLO aquí, después del toque explícito.
      await enablePush(venueId);
      await refresh();
      ui.success("Avisos activos en este dispositivo.");
    } catch (e) {
      ui.error(e.message || "No pudimos activar los avisos.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (busy) return;
    setBusy(true);
    try {
      await retryPushRegistration(venueId);
      await refresh();
      ui.success("Registro confirmado por el servidor.");
    } catch (e) {
      ui.error(e.message || "El registro sigue pendiente.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (busy) return;
    setBusy(true);
    try {
      await disablePush();
      await refresh();
      ui.info("Avisos desactivados en este dispositivo.");
    } catch (e) {
      ui.error(e.message || "No pudimos desactivar los avisos.");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!state.endpoint) return;
    setBusy(true);
    setTestMsg(null);
    try {
      const res = await sendTestPush(venueId, state.endpoint);
      setTestMsg({ ok: res.sent, text: res.detail });
    } catch (e) {
      setTestMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  if (!state.ready) {
    return (
      <div className="pf-push-box" aria-busy="true">
        <p className="pf-push-title">Avisos a este dispositivo</p>
        <p className="pf-hint">Comprobando permiso y registro…</p>
      </div>
    );
  }

  let title = "Avisos a este dispositivo";
  let description = "";
  let action = null;

  if (!state.supported) {
    description =
      state.error ||
      "Este navegador no soporta notificaciones push. La campana interna sigue funcionando.";
  } else if (!state.serverEnabled) {
    description =
      state.error ||
      "El servidor no tiene configurado el envío push. La campana interna sigue funcionando.";
  } else if (state.permission === "denied") {
    title = "Permiso bloqueado";
    description =
      "Bloqueaste las notificaciones para Enty. Habilítalas en los ajustes del navegador (candado en la barra de direcciones → Notificaciones) y recarga la página.";
  } else if (state.permission === "default") {
    description =
      "El navegador todavía no dio permiso. No pediremos nada hasta que toques el botón.";
    action = (
      <button type="button" onClick={activate} disabled={busy} className="btn-primary">
        {busy ? "Activando…" : "Activar avisos en este dispositivo"}
      </button>
    );
  } else if (!state.registered) {
    title = "Permiso concedido, registro pendiente";
    description = state.subscribed
      ? "El dispositivo está suscrito, pero el servidor no confirma su registro para esta organización."
      : "El navegador dio permiso, pero este dispositivo aún no tiene una suscripción activa.";
    action = state.subscribed ? (
      <button type="button" onClick={retry} disabled={busy} className="btn-primary">
        {busy ? "Reintentando…" : "Reintentar registro"}
      </button>
    ) : (
      <button type="button" onClick={activate} disabled={busy} className="btn-primary">
        {busy ? "Activando…" : "Suscribir este dispositivo"}
      </button>
    );
  } else {
    title = "Avisos activos en este dispositivo";
    description = state.registeredAt
      ? "Registro confirmado por el servidor. Recibirás avisos de puerta de esta organización."
      : "Registro confirmado por el servidor.";
    action = (
      <div className="pf-push-actions">
        <button type="button" onClick={test} disabled={busy} className="btn-ghost pf-action">
          Enviar aviso de prueba
        </button>
        <button
          type="button"
          onClick={turnOff}
          disabled={busy}
          className="btn-ghost pf-action pf-action-danger"
        >
          Desactivar en este dispositivo
        </button>
      </div>
    );
  }

  return (
    <div className="pf-push-box" data-state={state.registered ? "on" : "off"}>
      <div className="pf-push-head">
        <span className={`pf-push-dot ${state.registered ? "is-on" : ""}`} aria-hidden="true" />
        <p className="pf-push-title">{title}</p>
      </div>
      <p className="pf-hint pf-push-copy">{description}</p>
      {action}
      {testMsg && (
        <p
          role="status"
          className={`pf-alert ${testMsg.ok ? "pf-alert-ok" : "pf-alert-bad"}`}
        >
          {testMsg.text}
        </p>
      )}
    </div>
  );
}
