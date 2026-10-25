import { useCallback, useEffect, useState } from "react";
import { fetchLegalStatus, recordAcceptance } from "../lib/legal";
import { captureError } from "../lib/sentry";
import { forceDarkOnce } from "../lib/theme";
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

  // El panel es negro de marca en AMBOS temas (es una compuerta, no una
  // pantalla del tema del usuario). Sin el candado, en claro el texto tomaba
  // los tokens del tema —tinta oscura sobre el negro fijo— y medía 1.1:1.
  useEffect(() => forceDarkOnce(), []);

  // La compuerta bloquea el contenido de Layout, así que la ruta de debajo
  // nunca monta y su título no llega a aplicarse: sin esto, /promotor y
  // cualquier panel pendiente quedaban con el <title> genérico de index.html.
  useDocumentTitle("Documentos legales");

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
      <div className="flex min-h-screen items-center justify-center bg-[#0b0b0f] text-sm text-zinc-400">
        Revisando tus documentos…
      </div>
    );
  }
  if (pending.length === 0) return null;

  const allChecked = pending.every((d) => checked[d.slug]);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#0b0b0f] px-4 py-10">
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
              className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"
            >
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={!!checked[d.slug]}
                  onChange={(e) =>
                    setChecked((c) => ({ ...c, [d.slug]: e.target.checked }))
                  }
                  className="mt-1 h-4 w-4 shrink-0 accent-[#7C3AED]"
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
                    className="mt-1 text-xs text-zinc-400 underline decoration-zinc-600 underline-offset-2 hover:text-ink"
                  >
                    Leer el documento
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
          className="btn-primary mt-6 w-full disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Registrando…" : "Acepto y continúo"}
        </button>
        <p className="mt-3 text-center text-2xs text-zinc-500">
          Puedes abrir cada documento en una pestaña nueva y volver aquí.
        </p>
      </div>
    </div>
  );
}
