import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchLegalBody, fetchLegalDocuments, LEGAL_DOCS } from "../lib/legal";
import { Markdown } from "../lib/markdown";
import { Logo } from "../components/Brand";
import { LegalLinks } from "../components/LegalLinks";
import useDocumentTitle from "../lib/useDocumentTitle";

/**
 * Documento legal público.
 *
 * Sin autenticación y sin `Layout`: lo abre tanto el dueño del bar que va a
 * aceptar los términos como el invitado que quiere saber qué aceptó antes de
 * entrar al evento. El texto se sirve desde la API (una sola copia, la misma que
 * la base marca como aceptada) y la versión vigente se muestra arriba: si el
 * documento cambia, la fecha y la versión visibles cambian con él.
 *
 * La PÁGINA es dueña del `<h1>` y del título de documento (convención del
 * proyecto: un solo h1 por pantalla, ver a11y.spec.js). El markdown de cada
 * documento abre con su propio `# título`, que aquí sería un segundo h1: se
 * descarta esa primera línea y el encabezado visible sale del catálogo, de modo
 * que el h1 existe siempre — también mientras carga o si el texto no está
 * desplegado.
 */
export default function LegalPage({ slug }) {
  const nav = useNavigate();
  const [doc, setDoc] = useState(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // Fallback del catálogo local: el título (y el h1) no dependen de que la API
  // responda, así la pantalla nunca queda sin encabezado ni con <title> genérico.
  const title =
    doc?.title ??
    LEGAL_DOCS.find((d) => d.slug === slug)?.label ??
    "Documento legal";
  useDocumentTitle(title);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");

    Promise.all([fetchLegalDocuments(), fetchLegalBody(slug)])
      .then(([catalog, body]) => {
        if (!alive) return;
        setDoc(catalog.documents.find((d) => d.slug === slug) ?? null);
        setText(body);
      })
      .catch((e) => {
        if (alive) setError(e.message || "No pudimos cargar el documento.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [slug]);

  // Al cambiar de documento, volver arriba: si no, se abre a mitad de página.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [slug]);

  // El markdown repite el título como `# ...` en su primera línea: se quita
  // para no duplicar el h1 de la página.
  const body = text.replace(/^#\s+[^\n]*\n+/, "");

  return (
    <div className="legal-page min-h-screen">
      <header className="legal-header sticky top-0 z-10">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => nav("/")}
            className="flex min-h-11 items-center gap-2 rounded-lg px-1 py-1 transition hover:opacity-80"
            aria-label="Enty, ir al inicio"
          >
            <Logo size="md" />
          </button>
          <nav className="legal-links">
            {LEGAL_DOCS.filter((d) => d.slug !== slug).map((d) => (
              <button key={d.slug} type="button" onClick={() => nav(d.path)}>
                {d.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        <p className="legal-muted text-xs uppercase tracking-wide">Legal</p>
        <h1 className="display mt-1 mb-6 text-2xl">{title}</h1>

        {loading && (
          <p className="legal-muted text-sm" role="status">
            Cargando documento…
          </p>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300"
          >
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="legal-note mb-6 rounded-xl px-4 py-3 text-xs leading-relaxed">
              <strong className="font-semibold">Versión {doc?.version}</strong>
              {doc?.effective_date ? ` · vigente desde ${doc.effective_date}` : ""}
              {doc?.requires_acceptance
                ? " · documento de aceptación obligatoria"
                : " · documento informativo"}
            </div>
            <Markdown text={body} />
          </>
        )}
      </main>

      <footer className="mx-auto max-w-3xl px-4 pb-10 pt-2">
        <div className="legal-muted pt-4 text-xs">
          <LegalLinks current={slug} />
        </div>
      </footer>
    </div>
  );
}
