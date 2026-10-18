import { useCallback, useEffect, useState } from "react";
import { fetchLegalStatus, recordAcceptance } from "../lib/legal";
import { captureError } from "../lib/sentry";
import { Skeleton } from "./Skeleton";
import Icon from "./Icon";
import useDocumentTitle from "../lib/useDocumentTitle";

/**
 * Gate de aceptación legal para cuentas existentes.
 *
 * El registro nuevo acepta en RegisterPage y el invitado acepta en su boleta,
 * pero QUEDA FUERA quien ya tenía cuenta: cuando los documentos cambian de
 * versión (mig 026/027), /legal/status lista lo que le falta y nadie se lo
 * muestra. Sin esta pantalla, la aceptación versionada no llega a nadie y la
 * prueba de consentimiento no cubre a los usuarios actuales.
 *
 * Decisiones:
 * - Bloquea el contenido de Layout: no es un banner descartable, es la
 *   puerta que hace exigible el contrato (la aceptación queda registrada con
 *   IP y user-agent en la DB).
 * - Cada pendiente tiene su checkbox y su enlace al texto: no se acepta lo
 *   que no se puede leer (el enlace abre la página legal y vuelve con
 *   history.back()).
 * - Fail-open en la REVISIÓN inicial: si /legal/status no responde (red
 *   mala, API caída), no se le cierra la puerta a un usuario que solo
 *   quiere su panel — se reporta a Sentry y se sigue. La aceptación es
 *   idempotente en la DB, así que un reintento posterior converge.
 * - Fail-closed en el REGISTRO de la aceptación: si falla, el botón se
 *   reintentó y el usuario ve el error; nunca se finge "aceptado".
 */
export function LegalGate({ onCleared }) {
  const [pending, setPending] = useState(null); // null = revisando
  const [checked, setChecked] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // El gate sustituye al panel: la pantalla de rol no llega a montarse, así
  // que su useDocumentTitle nunca corre. El gate pone el suyo mientras
  // bloquea; al ceder, la página recupera el suyo.
  const blocking = pending === null || pending.length > 0;
  useDocumentTitle(blocking ? "Documentos legales" : null);

  const refresh = useCallback(async () => {
    try {
      const status = await fetchLegalStatus();
      const items = status.pending || [];
      setPending(items);
      // onCleared(true) y no onCleared(): el handler de Layout es un setState,
      // asi que onCleared() guardaba undefined -> el guard `!legalCleared`
      // seguia abierto, LegalGate re-renderizaba con pending=[] y devolvia
      // null. Resultado: la app entera en negro tras aceptar.
      if (items.length === 0) onCleared(true);
    } catch (e) {
      // Fail-open: sin estado no hay nada que pedir todavía. Se reporta y
      // se deja pasar; el proximo montaje vuelve a preguntar.
      captureError(e, { kind: "legal_status" });
      setPending([]);
      onCleared(true);
    }
  }, [onCleared]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function acceptAll() {
    setBusy(true);
    setError("");
    try {
      // Secuencial e idempotente (ON CONFLICT DO NOTHING en la DB): un
      // corte a mitad deja lo ya aceptado aceptado y el resto se repite.
      for (const d of pending) {
        await recordAcceptance({ slug: d.slug, version: d.version });
      }
      await refresh();
    } catch (e) {
      setError(e.message || "No pudimos registrar tu aceptación. Reintenta.");
    } finally {
      setBusy(false);
    }
  }

  if (pending === null) {
    return (
      <div className="legal-island grid min-h-screen place-items-center px-4">
        <div className="w-full max-w-xl" aria-busy="true">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="mt-3 h-7 w-72" />
          <Skeleton className="mt-3 h-4 w-full" />
          <div className="mt-6 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"
              >
                <Skeleton className="mt-1 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-48" />
                  <Skeleton className="h-2.5 w-24" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (pending.length === 0) return null;

  const allChecked = pending.every((d) => checked[d.slug]);

  return (
    <div className="legal-island fixed inset-0 z-50 overflow-y-auto px-4 py-10">
      <div className="mx-auto max-w-xl">
        <p className="eyebrow">Documentos legales</p>
        <h1 className="display mt-1 text-2xl">Hay cambios en los términos</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Actualizamos la documentación de la plataforma. Necesitamos que la
          leas y la aceptes para seguir operando: queda registrada con fecha y
          versión.
        </p>

        <ul className="mt-6 space-y-3">
          {pending.map((d) => (
            <li
              key={d.slug}
              className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition has-checked:border-brand-500/60 has-checked:bg-zinc-900"
            >
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={!!checked[d.slug]}
                  onChange={(e) =>
                    setChecked((c) => ({ ...c, [d.slug]: e.target.checked }))
                  }
                  className="mt-1 h-4 w-4 shrink-0 accent-enty-violet"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-zinc-100">
                    {d.title}{" "}
                    <span className="font-normal text-zinc-500">
                      · v{d.version}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => window.open(d.url, "_blank")}
                    className="mt-1 inline-flex items-center gap-1 text-xs text-zinc-400 underline decoration-zinc-600 underline-offset-2 transition hover:text-white"
                  >
                    Leer el documento
                    <Icon name="link" className="h-3 w-3" />
                  </button>
                </span>
              </label>
            </li>
          ))}
        </ul>

        {error && (
          <p role="alert" className="mt-4 text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={acceptAll}
          disabled={!allChecked || busy}
          className={`btn-primary mt-6 w-full ${busy ? "is-busy" : ""}`}
        >
          {busy && (
            <svg className="btn-spinner" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
            </svg>
          )}
          {busy ? "Registrando…" : "Acepto y continúo"}
        </button>
        <p className="mt-3 text-center text-[11px] text-zinc-500">
          Puedes abrir cada documento en una pestaña nueva y volver aquí.
        </p>
      </div>
    </div>
  );
}
