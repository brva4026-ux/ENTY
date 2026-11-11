/**
 * Sonidos de puerta con WebAudio: cero archivos, cero dependencias.
 *
 * En un ambiente ruidoso la vibración no se siente y mirar la pantalla no
 * siempre es posible: el oído es el canal de respaldo del bouncer. Cada
 * resultado tiene su firma:
 *   - ENTRA (verde): "ding" ascendente (2 notas agudas) — positivo, agudo.
 *   - RECHAZO (rojo): "bzzt" grave descendente — negativo, grave.
 *   - ÁMBAR (atención): doble bip neutro — ni positivo ni negativo.
 *   - SIN RED: triple bip largo — "no puedes trabajar así".
 *
 * Los osciladores se crean por llamada: no hay loop de audio colgado, y el
 * AudioContext se crea perezoso (iOS exige un gesto del usuario para
 * permitir audio; el primer toque en "Activar cámara" ya lo habilita).
 * Nada de esto suena si el dispositivo está en silencio físico — el bouncer
 * decide con el switch del teléfono, como en cualquier app nativa.
 */

let ctx = null;

/** AudioContext perezoso: se crea (o re-anima) en el primer uso tras un gesto. */
function audioCtx() {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx || ctx.state === "closed") ctx = new AC();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Un tono simple con envolvente.
 * @param {number} freq       Frecuencia en Hz.
 * @param {number} start      Segundo (relativo) donde arranca.
 * @param {number} dur        Duración del tono en segundos.
 * @param {"sine"|"square"|"triangle"} type Timbre: square/grave = "bzzt".
 * @param {number} gain       Volumen pico (0-1). Grave y bajo = rechazo.
 */
function tone(freq, start, dur, type, gain) {
  const ac = audioCtx();
  if (!ac) return;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime + start);
  amp.gain.setValueAtTime(0, ac.currentTime + start);
  amp.gain.linearRampToValueAtTime(gain, ac.currentTime + start + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur);
  osc.connect(amp).connect(ac.destination);
  osc.start(ac.currentTime + start);
  osc.stop(ac.currentTime + start + dur + 0.05);
}

/** Verde: "ding" ascendente — agudo, corto, alegre. Distingue a oído. */
export function playGranted() {
  tone(880, 0, 0.12, "sine", 0.22);
  tone(1320, 0.11, 0.18, "sine", 0.22);
}

/** Rojo: "bzzt" grave descendente — el clásico "error" de máquina. */
export function playRejected() {
  tone(220, 0, 0.16, "square", 0.18);
  tone(160, 0.15, 0.22, "square", 0.18);
}

/** Ámbar (NOT_ACTIVE / fila equivocada): doble bip neutro de "atención". */
export function playAttention() {
  tone(620, 0, 0.09, "triangle", 0.2);
  tone(620, 0.16, 0.09, "triangle", 0.2);
}

/** Sin red: triple bip largo — nada de esto funciona hasta reconectar. */
export function playOffline() {
  tone(440, 0, 0.22, "triangle", 0.2);
  tone(440, 0.3, 0.22, "triangle", 0.2);
  tone(440, 0.6, 0.22, "triangle", 0.2);
}

/** Firma sonora por código de resultado del escáner. */
export function playForCode(code) {
  if (code === "GRANTED") return playGranted();
  if (
    code === "NOT_ACTIVE" ||
    code === "WRONG_TYPE" ||
    code === "NOT_IN_CACHE"
  )
    return playAttention();
  if (code === "NETWORK_ERROR") return playOffline();
  return playRejected(); // todo lo demás: no entra
}
