import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { fetchPublicTicket } from "../lib/api";
import { eventDate } from "../lib/format";
import Icon from "./Icon";
import { useDialogA11y } from "../lib/useDialogA11y";

/**
 * Probador de QR del admin.
 *
 * Por que existe: el admin no puede probar un QR "de verdad" sin canjearlo
 * (canjear consume la boleta y genera ruido en los reportes). Este probador
 * llama a /tickets/preview — el MISMO endpoint publico del invitado — que
 * devuelve los datos de la boleta SIN canjearla. Resultado: puedes verificar
 * que el QR de una boleta sirve, quien es, y en que estado esta, sin tocar
 * nada.
 *
 * Dos formas de probar: camara (escanea el QR de la pantalla del telefono del
 * invitado) o pegar el enlace/token crudo (si te lo pasaron por WhatsApp para
 * revisarlo antes de emitir juicio).
 */
export default function QrTesterModal({ onClose }) {
  const { dialogRef, titleId } = useDialogA11y({ onClose });
  const [scanning, setScanning] = useState(false);
  const [camError, setCamError] = useState("");
  const [manual, setManual] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null); // {ok, data|error}
  const html5Ref = useRef(null);

  useEffect(() => {
    // Escape y foco los maneja useDialogA11y; aquí solo se apaga la cámara.
    return () => stopCam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCam() {
    setCamError("");
    setResult(null);
    try {
      const qr = new Html5Qrcode("qr-tester-region");
      html5Ref.current = qr;
      await qr.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (text) => {
          // Primera lectura valida detiene la camara: no procesar en loop.
          stopCam().then(() => check(text));
        },
        () => {},
      );
      setScanning(true);
    } catch (err) {
      setCamError("No se pudo iniciar la camara: " + (err?.message || err));
    }
  }

  async function stopCam() {
    if (!html5Ref.current) return;
    try {
      await html5Ref.current.stop();
      await html5Ref.current.clear();
    } catch {
      /* ignore */
    }
    html5Ref.current = null;
    setScanning(false);
  }

  /** Extrae el token crudo de lo escaneado/pegado: acepta enlace completo
   * (`https://app/t#ABC...`), solo fragmento (`#ABC...`) o token puro. */
  function extractToken(input) {
    const s = String(input || "").trim();
    if (!s) return "";
    const hash = s.lastIndexOf("#");
    if (hash !== -1) return s.slice(hash + 1).trim();
    return s;
  }

  async function check(input) {
    const token = extractToken(input);
    if (!token) return;
    setChecking(true);
    setResult(null);
    try {
      const data = await fetchPublicTicket(token);
      setResult({ ok: true, data });
    } catch (err) {
      setResult({ ok: false, error: err?.message || "Token invalido" });
    } finally {
      setChecking(false);
    }
  }

  const t = result?.ok ? result.data : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        ref={dialogRef}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-zinc-800 bg-zinc-900 shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
              <Icon name="qr" className="h-5 w-5 text-brand-400" />
              Probador de QR
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Solo consulta la boleta — nunca la canjea
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Cerrar"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {/* Camara */}
          {!scanning && (
            <button
              onClick={startCam}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 py-6 text-sm font-medium text-zinc-300 transition hover:border-brand-500/60 hover:bg-brand-500/5 hover:text-brand-300"
            >
              <Icon name="camera" className="h-5 w-5" />
              Escanear con la camara
            </button>
          )}
          <div
            id="qr-tester-region"
            className={scanning ? "overflow-hidden rounded-xl" : "hidden"}
          />
          {scanning && (
            <button
              onClick={stopCam}
              className="w-full rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-300 transition hover:bg-zinc-800"
            >
              Detener camara
            </button>
          )}
          {camError && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {camError}
            </p>
          )}

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-zinc-800" />
            <span className="text-2xs uppercase tracking-wider text-zinc-600">
              o pegar
            </span>
            <span className="h-px flex-1 bg-zinc-800" />
          </div>

          {/* Pegar enlace/token */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              check(manual);
            }}
            className="flex gap-2"
          >
            <input
              aria-label="Enlace o token de la boleta"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Enlace del invitado (…/t#TOKEN) o token"
              className="field flex-1 font-mono text-xs"
              spellCheck="false"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={checking || !manual.trim()}
              className="btn-primary shrink-0 px-4 text-sm disabled:opacity-40"
            >
              {checking ? "…" : "Probar"}
            </button>
          </form>

          {/* Resultado */}
          {result && !checking && (
            <div
              className={`rounded-xl border p-4 ${
                result.ok
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : "border-red-500/30 bg-red-500/10"
              }`}
            >
              {result.ok ? (
                <div className="space-y-2">
                  <p className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
                    <Icon name="check" className="h-4 w-4" />
                    El QR sirve — boleta encontrada
                  </p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-300">
                    <dt className="text-zinc-500">Invitado</dt>
                    <dd className="font-medium">{t.customer_name}</dd>
                    <dt className="text-zinc-500">Estado</dt>
                    <dd>
                      {t.status}
                      {t.qr_active === false && t.qr_message
                        ? ` · ${t.qr_message}`
                        : ""}
                    </dd>
                    <dt className="text-zinc-500">Evento</dt>
                    <dd>
                      {t.event_name}
                      {t.starts_at ? ` · ${eventDate(t.starts_at)}` : ""}
                    </dd>
                    {t.venue_name && (
                      <>
                        <dt className="text-zinc-500">Lugar</dt>
                        <dd>
                          {t.venue_name}
                          {t.location ? ` — ${t.location}` : ""}
                        </dd>
                      </>
                    )}
                  </dl>
                </div>
              ) : (
                <p className="flex items-start gap-2 text-sm text-red-300">
                  <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
                  {result.error}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
