"""Categorías de evento (mig 043): una sola lista para la DB, el catálogo
público y los validadores.

Antes la categoría no existía en la base: el catálogo público la ADIVINABA del
texto del evento (`_category_of`) y caía en "Música" por defecto. Una
graduación o una fiesta privada salían como música sin que el organizador
pudiera corregirlo. Ahora el organizador elige; la heurística queda solo como
fallback para eventos viejos o sin categoría elegida.

El orden importa: es el que ve el selector en la UI.
"""

EVENT_CATEGORIES = (
    "Música",
    "Deportes",
    "Teatro",
    "Fiesta",
    "Cultural",
    "Académico",
    "Comedia",
    "Otro",
)

# Lista acotada en la DB (mig 043, events_category_check). Si cambia, hay que
# migrar la constraint también.
_DB_ALLOWED = frozenset(EVENT_CATEGORIES)


def validate_event_category(value: str | None, *, allow_blank: bool = False) -> str | None:
    """Valida y normaliza una categoría elegida.

    - None -> None (sin elegir; el catálogo infiere).
    - "" con allow_blank -> None (el PATCH usa "" para limpiar la elección).
    - Cualquier otro valor debe estar en EVENT_CATEGORIES (403 si no).

    La comparación tolera espacios y diferencias de mayúsculas/acentos no: el
    valor canónico es el de EVENT_CATEGORIES, y se devuelve ESE, no el del
    usuario (así "musica" y "Música " guardan lo mismo).
    """
    if value is None:
        return None
    text = value.strip()
    if not text:
        if allow_blank:
            return None
        raise ValueError("La categoría no puede estar en blanco")
    if text not in _DB_ALLOWED:
        raise ValueError(
            "Categoría inválida: usa una de " + ", ".join(EVENT_CATEGORIES)
        )
    return text
