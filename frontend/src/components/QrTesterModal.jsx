import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
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
const TICKET_STATUS = {
  issued: "Emitida",
  redeemed: "Ingreso registrado",
  voided: "Anulada",
  refunded: "Reembolsada",
};

export default function QrTesterModal({ onClose }) {
  const { dialogRef, titleId } = useDialogA11y({ onClose });
  const [starting, setStarting] = useState(false);
  const mounted = useRef(false);
  const [scanning, setScanning] = useState(false);
  const [camError, setCamError] = useState("");
  const [manual, setManual] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null); // {ok, data|error}
  const html5Ref = useRef(null);
  // Botón que reemplaza al de arrancar la cámara: recibe el foco cuando el
  // original se desmonta (si no, el foco cae al body y se pierde la posición).
  const stopBtnRef = useRef(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void stopCam();
    };
  }, []);

  useEffect(() => {
    if (scanning) stopBtnRef.current?.focus();
  }, [scanning]);

  async function startCam() {
    flushSync(() => {
      setStarting(true);
      setCamError("");
      setResult(null);
    });
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      if (!mounted.current) return;
      const qr = new Html5Qrcode("qr-tester-region");
      html5Ref.current = qr;
      let scanned = false;
      await qr.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: (width, height) => {
            const size = Math.floor(Math.min(width, height) * 0.72);
            return { width: size, height: size };
          },
        },
        (value) => {
          if (scanned || !mounted.current) return;
          scanned = true;
          void stopCam();
          void check(value);
        },
        () => {},
      );
      if (!mounted.current) {
        await releaseCamera(qr);
      } else if (!scanned && html5Ref.current === qr) {
        setScanning(true);
      }
    } catch {
      await stopCam();
      if (mounted.current) {
        setCamError("No pudimos abrir la cámara. Revisa el permiso o pega el enlace de la boleta.");
      }
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  async function releaseCamera(qr) {
    try {
      if (qr.isScanning) await qr.stop();
      qr.clear();
    } catch {
      // The region may have been removed while the camera was opening.
    }
  }

  async function stopCam() {
    const qr = html5Ref.current;
    html5Ref.current = null;
    if (qr?.isScanning) await releaseCamera(qr);
    if (mounted.current) setScanning(false);
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

  return createPortal(
    <div
      className="dialog-backdrop fixed inset-0 z-[100] flex items-end justify-center overflow-y-auto p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="dialog-panel my-auto max-w-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <span className="dialog-grab" aria-hidden="true" />
        <div className="dialog-head">
          <div className="min-w-0">
            <h2 id={titleId} className="dialog-title flex items-center gap-2">
              <Icon name="qr" className="h-5 w-5 text-brand-400" />
              Probador de QR
            </h2>
            <p className="dialog-sub">
              Consulta el estado de la boleta sin registrar un ingreso.
            </p>
          </div>
          <button
            onClick={onClose}
            className="dialog-close"
            aria-label="Cerrar"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        <div className="dialog-body space-y-4">
          {/* Camara */}
          {!scanning && (
            <button
              type="button"
              disabled={starting || checking}
              onClick={startCam}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 py-6 text-sm font-medium text-zinc-300 transition hover:border-brand-500/60 hover:bg-brand-500/5 hover:text-brand-300"
            >
              <Icon name="camera" className="h-5 w-5" />
              {starting ? "Abriendo cámara…" : "Escanear con cámara"}
            </button>
          )}
          <div
            id="qr-tester-region"
            className={scanning || starting ? "overflow-hidden rounded-xl" : "hidden"}
          />
          {scanning && (
            <button
              ref={stopBtnRef}
              onClick={stopCam}
              className="w-full rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-300 transition hover:bg-zinc-800"
            >
              Detener cámara
            </button>
          )}
          {camError && (
            <p
              role="alert"
              className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300"
            >
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
              aria-label="Enlace o código de la boleta"
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
              {checking ? "Probando…" : "Probar"}
            </button>
          </form>

          {/* Resultado */}
          {result && !checking && (
            <div
              role="status"
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
                    Boleta encontrada
                  </p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-300">
                    <dt className="text-zinc-500">Invitado</dt>
                    <dd className="font-medium">{t.customer_name}</dd>
                    <dt className="text-zinc-500">Estado</dt>
                    <dd>
                      {TICKET_STATUS[t.status] || t.status}
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
    </div>,
    document.body,
  );
}
