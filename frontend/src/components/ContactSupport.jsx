import { SITE } from "../lib/site";
import { waLink } from "../lib/whatsapp";
import Icon from "./Icon";

/**
 * El canal de ayuda de la entrada: un enlace REAL a WhatsApp (no un botón con
 * `window.open`), para que funcione el clic derecho, "abrir en pestaña nueva"
 * y "copiar enlace", y para que un lector de pantalla lo anuncie como enlace.
 *
 * El número y el mensaje salen de SITE/lib, no del JSX: cambiar el soporte es
 * tocar un dato, no buscar un string por las pantallas.
 */
export default function ContactSupport({
  prompt = "¿Problemas para entrar?",
  label = "Contáctanos",
  message = "Hola, necesito ayuda con Enty.",
  className = "",
}) {
  const href = waLink(SITE.supportWhatsApp, message);
  // Sin un número usable no se pinta un enlace roto: mismo criterio que el
  // "encargar por WhatsApp" de la portada.
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`auth-contact ${className}`.trim()}
    >
      <Icon name="whatsapp" className="auth-contact-icon" />
      <span className="auth-contact-text">
        {prompt}
        <strong>{label}</strong>
      </span>
    </a>
  );
}
