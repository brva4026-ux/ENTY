import { useEffect } from "react";

/**
 * Titulo de documento por ruta. Sin esto TODAS las pantallas comparten el
 * <title> estatico de index.html: una pestana abierta en un evento, un enlace
 * compartido por WhatsApp y el anuncio del lector de pantalla mostraban todos
 * "Enty — Boleteria y Aforo", nunca el nombre del evento.
 *
 * `title` sin marca se sufija con " · Enty". Pasar `null` mientras cargan los
 * datos deja el titulo actual (no parpadea a un texto generico).
 */
const BRAND = "Celestial Strokes";

export default function useDocumentTitle(title) {
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = title.includes(BRAND) ? title : `${title} · ${BRAND}`;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
