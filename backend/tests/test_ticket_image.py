"""Composición de la boleta-imagen (Pillow + QR).

No necesita base de datos: valida la pieza que el cliente final recibe por
WhatsApp. Es el test que corre siempre, incluso sin Postgres.
"""
from io import BytesIO

import pytest
from PIL import Image, ImageFont

from app.services.ticket_image import _load_font, build_ticket_image

JPEG_MAGIC = b"\xff\xd8\xff"


def _render(**overrides) -> bytes:
    kwargs = {
        "ticket_number": 42,
        "customer_name": "Ana Pérez",
        "event_name": "Noche Electrónica",
        "starts_at": "01/10/2026 20:00 (-05)",
        "raw_token": "token-de-prueba-1234567890",
        "venue_name": "Bar Esquina",
    }
    kwargs.update(overrides)
    return build_ticket_image(**kwargs)


def test_returns_a_jpeg_of_the_expected_size():
    data = _render()
    assert data.startswith(JPEG_MAGIC)

    with Image.open(BytesIO(data)) as img:
        assert img.format == "JPEG"
        assert img.size == (900, 500)
        assert img.mode == "RGB"


def test_qr_changes_with_the_token():
    """El QR codifica el token crudo: dos boletas no pueden verse iguales."""
    assert _render() != _render(raw_token="otro-token-de-prueba-9876543210")


def test_rendering_is_deterministic():
    """Misma boleta, misma imagen (no hay ruido ni aleatoriedad)."""
    assert _render() == _render()


@pytest.mark.parametrize(
    "field",
    [
        {"customer_name": "Nombre muy largo " * 12},
        {"event_name": "Evento con un nombre absurdamente largo " * 8},
        {"venue_name": ""},
        {"starts_at": ""},
    ],
)
def test_extreme_inputs_do_not_crash(field):
    assert _render(**field).startswith(JPEG_MAGIC)


def test_font_is_scaled_to_the_requested_size():
    """El texto debe ser legible también sin DejaVu (imágenes Docker slim)."""
    font = _load_font(40)
    assert isinstance(font, ImageFont.FreeTypeFont)
    assert font.size == 40
