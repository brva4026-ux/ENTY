import { useEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "../lib/motion";

const POSTER = "/media/login-showcase-poster.jpg";

function PlayIcon({ paused }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {paused ? (
        <path d="M8 5.5v13l10.5-6.5L8 5.5Z" />
      ) : (
        <>
          <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" />
          <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" />
        </>
      )}
    </svg>
  );
}

function useDesktop() {
  const [desktop, setDesktop] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return true;
    return window.matchMedia("(min-width: 1024px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  return desktop;
}

/**
 * Pieza audiovisual de la entrada.
 *
 * En escritorio el clip arranca silenciado y en loop; en móvil manda la
 * portada y el video se pide con el botón (ahorra datos y no abre el teclado
 * encima de una reproducción que nadie pidió). La portada ocupa el mismo
 * espacio que el video, así el formulario no salta cuando llega el archivo.
 */
export function LoginShowcase() {
  const desktop = useDesktop();
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);

  const reduced = prefersReducedMotion();
  const saveData =
    typeof navigator !== "undefined" && navigator.connection?.saveData === true;
  const autoPlay = desktop && !reduced && !saveData;

  useEffect(() => {
    if (!autoPlay || failed) return;
    const el = videoRef.current;
    if (!el) return;
    const promise = el.play?.();
    if (promise && typeof promise.catch === "function") promise.catch(() => {});
  }, [autoPlay, failed]);

  async function toggle() {
    const el = videoRef.current;
    if (!el || failed) return;
    if (playing) {
      el.pause();
      return;
    }
    try {
      await el.play();
    } catch {
      setPlaying(false);
    }
  }

  return (
    <div
      className={`login-media${started ? " is-started" : ""}${failed ? " is-failed" : ""}`}
      aria-label="Video de demostración de Enty"
    >
      <img className="login-media-poster" src={POSTER} alt="" />
      <video
        ref={videoRef}
        className="login-media-video"
        poster={POSTER}
        muted
        loop
        playsInline
        preload={autoPlay ? "auto" : "none"}
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
        }}
        onPause={() => setPlaying(false)}
        onError={() => {
          setFailed(true);
          setPlaying(false);
        }}
      >
        <source src="/media/login-showcase.webm" type="video/webm" />
        <source src="/media/login-showcase.mp4" type="video/mp4" />
      </video>
      <span className="login-media-scrim" aria-hidden="true" />
      {!failed && (
        <button
          type="button"
          className="login-media-control"
          onClick={toggle}
          aria-label={playing ? "Pausar video" : "Reproducir video"}
          aria-pressed={playing}
        >
          <PlayIcon paused={!playing} />
        </button>
      )}
      <span className="login-media-caption">
        {failed ? "Portada de Enty" : "Demostración · silenciada"}
      </span>
    </div>
  );
}
