"""Generacion de la imagen de boleta: flyer base + codigo QR + datos del asistente.

Sin un motor de composicion pesado: Pillow dibuja directamente. El resultado es
un JPEG que se sirve por un media endpoint o se adjunta al wa.me de la boleta.
"""
import io

import qrcode
from PIL import Image, ImageDraw, ImageFont

_TICKET_W = 900
_TICKET_H = 500


def _load_font(size: int) -> ImageFont.FreeTypeFont:
    """Elige la fuente. Evita depender de sistema usando DejaVuSans (muy comun).

    En serverless la imagen base puede no traer DejaVu. `load_default(size)`
    devuelve una fuente escalable con ese tamano; sin el argumento seria una
    bitmap fija de 10px y el texto saldria ilegible en la boleta.
    """
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default(size)


def _qr_image(data: str) -> Image.Image:
    # Nivel H (30% de correccion de error): la boleta se muestra desde un
    # telefono con brillo bajo o pasa por WhatsApp (recompresion); con M
    # (15%) los escaneos fallaban mucho mas en la puerta.
    qr = qrcode.QRCode(border=1, error_correction=qrcode.constants.ERROR_CORRECT_H)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    return img.resize((260, 260), Image.LANCZOS)


def build_ticket_image(
    *,
    ticket_number: int,
    customer_name: str,
    event_name: str,
    starts_at: str,
    raw_token: str,
    venue_name: str,
    location: str | None = None,
    flyer: Image.Image | None = None,
) -> bytes:
    """Compone la imagen y devuelve bytes JPEG."""
    img = Image.new("RGB", (_TICKET_W, _TICKET_H), "#111122")

    if flyer is not None:
        flyer = flyer.convert("RGB").resize((_TICKET_W, _TICKET_H), Image.LANCZOS)
        img.paste(flyer, (0, 0))
        overlay = Image.new("RGBA", img.size, (10, 10, 30, 90))
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    else:
        draw = ImageDraw.Draw(img)
        draw.rectangle([0, 0, _TICKET_W, _TICKET_H], fill="#111122")

    draw = ImageDraw.Draw(img)

    font_title = _load_font(42)
    font_name = _load_font(40)
    font_meta = _load_font(24)
    font_pad = _load_font(20)

    # Panel izquierdo: datos del asistente
    x = 40
    y = 40
    draw.text((x, y), venue_name or "TicketFlow", font=font_title, fill="#FFFFFF")
    y += 70
    draw.text((x, y), "BOLETA", font=font_meta, fill="#FFD166")
    y += 50
    draw.text((x, y), customer_name, font=font_name, fill="#FFFFFF")
    y += 60
    draw.text((x, y), event_name, font=font_meta, fill="#DDDDDD")
    y += 45
    draw.text((x, y), f"Inicio: {starts_at}", font=font_meta, fill="#BBBBBB")
    y += 45
    # Lugar del evento (mig 014): si el admin lo escribió, viaja en la imagen
    # — el invitado ve DÓNDE es sin abrir la página.
    if location:
        draw.text((x, y), f"Lugar: {location}", font=font_meta, fill="#BBBBBB")
        y += 45
    draw.text((x, y), f"Boleta #{ticket_number}", font=font_meta, fill="#BBBBBB")
    y += 60
    draw.text((x, y), "Entera con la foto de tu documento", font=font_pad, fill="#888899")

    # QR a la derecha
    qr = _qr_image(raw_token)
    img.paste(qr, (_TICKET_W - 300, 130))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()