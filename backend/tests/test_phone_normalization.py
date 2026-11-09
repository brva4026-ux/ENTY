"""Contrato de la normalización de teléfono (T11: un solo criterio).

El mismo número escrito de formas distintas debe normalizar al mismo valor,
tanto en Python (`digits_only`) como en SQL (`phone_tail_sql`). Antes había
cuatro copias del criterio; este test fija el contrato único.
"""
from app.core.phone import digits_only, digits_sql, phone_tail_sql


def test_digits_only_drops_everything_but_digits():
    assert digits_only("+57 300 123-4567") == "573001234567"
    assert digits_only("(300) 123 4567") == "3001234567"
    assert digits_only(None) == ""
    assert digits_only("") == ""


def test_same_number_written_differently_has_the_same_tail():
    local = digits_only("3001234567")
    international = digits_only("+57 300 123-4567")
    assert local[-10:] == international[-10:] == "3001234567"


def test_sql_expressions_share_the_same_criterion():
    assert phone_tail_sql("t.customer_phone") == (
        "right(regexp_replace(coalesce(t.customer_phone, ''), '[^0-9]', '', 'g'), 10)"
    )
    # El largo es configurable (búsquedas por menos de 10 dígitos) y siempre
    # entero: nunca se interpola texto de entrada en el SQL.
    assert phone_tail_sql("c", 6).endswith(", 6)")
    assert digits_sql("c") == "regexp_replace(coalesce(c, ''), '[^0-9]', '', 'g')"
