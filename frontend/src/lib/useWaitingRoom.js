import { useCallback, useEffect, useRef, useState } from "react";

import { fetchWaitingRoomStatus, joinWaitingRoom } from "./api";

/**
 * Sala de espera virtual (mig 055/056).
 *
 * Mantiene al fan en la fila mientras espera su turno. El token de sesión vive
 * en `localStorage` por evento: recargar la página, cambiar de pestaña o
 * cerrar el navegador NO pierde el lugar. Es el mismo criterio que el resto de
 * la compra pública, donde el navegador es la identidad (no hay cuenta).
 *
 * Estados que devuelve:
 * - `idle`     la sala no está activa para este evento: comprar ya.
 * - `joining`  entrando a la fila (primera llamada).
 * - `waiting`  en la fila, con `position` y refresco periódico.
 * - `admitted` ya puede comprar, con `passToken` para el checkout.
 * - `error`    la sala no respondió; se ofrece reintentar.
 *
 * `enabled` es false cuando el evento no tiene sala: en ese caso el hook no
 * hace ni una petición y el checkout sigue como siempre.
 */
const STORAGE_PREFIX = "tf_waiting_session_";
// El servidor reparte de a tandas; preguntar cada 3 s da una sensación de
// fila viva sin castigar el backend (240 req/min por IP lo cubre de sobra).
const POLL_MS = 3_000;

function readSession(eventId) {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${eventId}`);
  } catch {
    return null;
  }
}

function writeSession(eventId, token) {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${eventId}`, token);
  } catch {
    // Modo privado con storage bloqueado: la sesión dura lo que la pestaña.
  }
}

function newSessionToken() {
  // 32 bytes en hex. `crypto.randomUUID` no existe en navegadores viejos, así
  // que se cae a `getRandomValues`, que sí es universal.
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replace(/-/g, "");
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b + 256).toString(16).slice(1)).join("");
}

export function useWaitingRoom(eventId, enabled) {
  const [state, setState] = useState(() =>
    enabled ? "joining" : "idle",
  );
  const [position, setPosition] = useState(null);
  const [passToken, setPassToken] = useState(null);
  const [error, setError] = useState(null);
  // La sesión se crea una vez por montaje: recrearla en cada render haría que
  // cada consulta fuera un fan nuevo y la fila no avanzaría nunca.
  const sessionRef = useRef(null);

  const ensureSession = useCallback(() => {
    if (sessionRef.current) return sessionRef.current;
    const existing = readSession(eventId);
    const token = existing || newSessionToken();
    if (!existing) writeSession(eventId, token);
    sessionRef.current = token;
    return token;
  }, [eventId]);

  const join = useCallback(async () => {
    if (!enabled) {
      setState("idle");
      return;
    }
    try {
      const res = await joinWaitingRoom(eventId, ensureSession());
      setError(null);
      if (res.status === "admitted" && res.pass_token) {
        setPassToken(res.pass_token);
        setState("admitted");
        setPosition(0);
      } else {
        setState("waiting");
        setPosition(res.queue_position ?? null);
      }
    } catch (err) {
      setError(err);
      setState("error");
    }
  }, [enabled, eventId, ensureSession]);

  useEffect(() => {
    if (!enabled) {
      setState("idle");
      return;
    }
    setState("joining");
    join();
  }, [enabled, join]);

  // Polling mientras espera. Se detiene en cuanto recibe el pase: seguir
  // preguntando después solo gasta peticiones.
  useEffect(() => {
    if (state !== "waiting") return;

    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetchWaitingRoomStatus(eventId, ensureSession());
        setPosition(res.queue_position ?? null);
        if (res.status === "admitted") {
          // El pase se entrega con el join, no con el status: al ver que ya
          // es su turno, se pide el pase explícitamente.
          await join();
        }
      } catch {
        // Un fallo de red no expulsa al fan de la fila: se reintenta al
        // siguiente tick.
      }
    };

    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [state, eventId, ensureSession, join]);

  return {
    state,
    position,
    passToken,
    error,
    retry: join,
  };
}
