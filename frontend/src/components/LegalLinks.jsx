import { useNavigate } from "react-router-dom";
import { LEGAL_DOCS } from "../lib/legal";

/**
 * Enlaces a los documentos legales.
 *
 * Componente propio (y no dentro de la página) por una razón de peso: las
 * pantallas de entrada lo usan, y la página legal carga el render de markdown.
 * Si esto viviera en `pages/LegalPage`, el render de markdown entraría al bundle
 * inicial de login/registro — que es justo lo que el code-splitting evita.
 *
 * `current` marca en qué documento estamos (aria-current, no solo color).
 */
export function LegalLinks({ current, className = "legal-links" }) {
  const nav = useNavigate();
  return (
    <nav className={className} aria-label="Documentos legales">
      {LEGAL_DOCS.map((d) => (
        <button
          key={d.slug}
          type="button"
          onClick={() => nav(d.path)}
          aria-current={d.slug === current ? "page" : undefined}
          className={d.slug === current ? "font-semibold" : undefined}
        >
          {d.label}
        </button>
      ))}
    </nav>
  );
}
