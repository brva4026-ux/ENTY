"""Normalización de teléfono en UN solo lugar.

El mismo número se guarda como lo escribió cada persona: "3001234567",
"+57 300 123-4567", "300-123-4567". Comparar literal deja boletas "perdidas"
aunque el número sea el mismo, así que se compara por los ULTIMOS 10 dígitos
(un móvil colombiano sin indicativo). El criterio estaba copiado en cuatro
consultas y con dos regexp distintas ('\\D' vs '[^0-9]'): cuatro oportunidades
de divergir. Aquí vive una sola vez.
"""
import re

_NON_DIGIT = re.compile(r"\D")


def digits_only(value: str | None) -> str:
    """Deja solo los dígitos de un teléfono escrito por una persona."""
    return _NON_DIGIT.sub("", value or "")


def digits_sql(column: str) -> str:
    """Expresión SQL con solo los dígitos de `column`.

    NULL/'' se tratan como cadena vacía para no arrastrar filas por accidente.
    """
    return "regexp_replace(coalesce(" + column + ", ''), '[^0-9]', '', 'g')"


def phone_tail_sql(column: str, length: int = 10) -> str:
    """Expresión SQL de los últimos `length` dígitos de `column`.

    `length` debe ser un int ya calculado (nunca texto de entrada): se
    interpola en el SQL, no se pasa como parámetro. `digits_only` + este
    recorte es el criterio único para comparar teléfonos.
    """
    return f"right({digits_sql(column)}, {int(length)})"
