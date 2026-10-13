import { Link } from "react-router-dom";
import useDocumentTitle from "../lib/useDocumentTitle";
import { SITE } from "../lib/site";

/**
 * Páginas legales de Enty (Términos y Privacidad). Eran el bloqueante para
 * operar de verdad: se cobra a través de la plataforma y no había dónde
 * asentarlo.
 *
 * Se separan de la app interna a propósito: son públicas, sin login, y su
 * contenido es PROSA (no producto). Un único layout `.legal` (ver
 * enty-fan.css) les da la misma voz que la vitrina sin reusar el chrome del
 * fan. Sora es la única tipografía, los colores salen de tokens --e-*, y el
 * texto pasa AA en ambos temas (lo verifica a11y.spec.js).
 *
 * IMPORTANTE: esto es un texto base honesto sobre lo que la app HACE hoy.
 * Antes de exponerlo en producción con cobros reales, revísalo con asesoría
 * legal de tu jurisdicción (ver `LEGAL_CONTACT`).
 */

const UPDATED = "11 de octubre de 2026";

export function LegalLayout({ title, intro, children }) {
  useDocumentTitle(title);
  return (
    <div className="legal">
      <header className="legal-top">
        <Link to="/inicio" className="legal-brand" aria-label="Enty, inicio">
          <span>Enty</span>
          <i aria-hidden="true" />
        </Link>
        <Link to="/inicio" className="legal-back">
          Volver
        </Link>
      </header>

      <main className="legal-wrap">
        <p className="eyebrow">Legal</p>
        <h1 className="display legal-title">{title}</h1>
        <p className="legal-updated">Última actualización: {UPDATED}</p>
        <p className="legal-intro">{intro}</p>
        <div className="legal-body">{children}</div>

        <footer className="legal-foot">
          <p>
            ¿Dudas sobre este documento? Escribe a{" "}
            <a className="legal-link" href={`mailto:${SITE.legalEmail}`}>
              {SITE.legalEmail}
            </a>
            .
          </p>
          <nav className="legal-nav" aria-label="Documentos legales">
            <Link to="/terminos">Términos y condiciones</Link>
            <Link to="/privacidad">Política de privacidad</Link>
            <Link to="/inicio">Inicio</Link>
          </nav>
        </footer>
      </main>
    </div>
  );
}
