/**
 * Documentos legales: catálogo, texto y registro de la aceptación.
 *
 * El TEXTO vive en el backend (backend/app/assets/legal/*.md) y la versión en la
 * tabla `legal_documents`: aquí solo se consume. Nada de duplicar el texto en el
 * bundle, o la app mostraría una versión distinta de la que la base considera
 * aceptada.
 */
import { apiFetch } from "./api";

const BASE = "/api";

/**
 * Slugs y ruta pública de cada documento.
 *
 * El orden es el de lectura y es el que se muestra en el pie legal. Los `path`
 * coinciden con la columna `url` de `legal_documents`: si se cambia uno, se
 * cambia el otro (el backend sirve el texto por slug, no por ruta).
 */
export const LEGAL_DOCS = [
  {
    slug: "terminos-plataforma",
    path: "/terminos",
    label: "Términos y Condiciones",
  },
  {
    slug: "terminos-boleta",
    path: "/terminos-boleta",
    label: "Términos de la Boleta",
  },
  { slug: "privacidad", path: "/privacidad", label: "Tratamiento de Datos" },
  { slug: "cookies", path: "/cookies", label: "Cookies" },
  { slug: "encargo-datos", path: "/encargo-datos", label: "Encargo de Datos" },
];

/** Los documentos que el registro exige aceptar (los demás solo se informan). */
export const REQUIRED_SLUGS = ["terminos-plataforma", "privacidad"];

/** Catálogo vigente + huella agregada de versiones (público). */
export function fetchLegalDocuments() {
  return apiFetch("/legal/documents");
}

/**
 * Markdown de un documento (público, texto plano).
 *
 * No usa `apiFetch` porque este siempre intenta `res.json()`: el markdown no es
 * JSON y el parseo fallaría silenciosamente devolviendo un objeto vacío.
 */
export async function fetchLegalBody(slug) {
  const res = await fetch(`${BASE}/legal/documents/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    const err = new Error(
      res.status === 404
        ? "Ese documento no existe."
        : "No pudimos cargar el documento.",
    );
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/**
 * Registra que alguien aceptó un documento.
 *
 * `apiFetch` adjunta el token de sesión si lo hay, así que la aceptación queda
 * atribuida a la cuenta cuando existe. Para el invitado sin cuenta, el sujeto
 * viaja en el cuerpo (`subject_phone`) y `ticket_token` ubica la boleta y su
 * venue — el token va en el CUERPO, nunca en la URL.
 */
export function recordAcceptance(payload) {
  return apiFetch("/legal/acceptances", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Qué acepté y qué me falta aceptar (autenticado). */
export function fetchLegalStatus() {
  return apiFetch("/legal/status");
}
