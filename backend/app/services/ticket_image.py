"""Generacion de la imagen de boleta: ticket de festival + codigo QR.

Sin un motor de composicion pesado: Pillow dibuja directamente. El resultado es
un JPEG que se sirve por un media endpoint o se adjunta al wa.me de la boleta.

La composicion imita una boleta troquelada de festival: campo indigo de fondo,
ticket ambar con perforacion punteada, datos del asistente a la izquierda y el
QR sobre panel blanco a la derecha (el talon). El titulo del evento va en la
misma display jugosa del ticket web (Shrikhand, OFL, embebida en app/assets)
y hay burbujas de confeti detras del talon, tipo cartel "Jazz Love Fest".
El QR se pega SIEMPRE en la posicion fija (W-300, 130) a 260px: el test
guardian compara esa region contra una referencia determinista del token.
"""
import io
import os

import qrcode
from PIL import Image, ImageDraw, ImageFont

_TICKET_W = 900
_TICKET_H = 500

# Paleta del ticket de festival (misma del icono y la boleta web)
_INDIGO = (42, 47, 143)
_INDIGO_OSCURO = (24, 27, 82)
_AMBAR = (240, 168, 50)
_AMBAR_CLARO = (245, 187, 96)
_TINTA = (34, 26, 6)
_TINTA_SUAVE = (74, 47, 5)
_CREMA = (255, 244, 224)
# Confeti estilo cartel: los mismos 4 acentos de la boleta web
_CONFETI = [(239, 108, 138), (52, 211, 153), (125, 153, 236), (255, 255, 255)]

_ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "fonts")


def _load_font(size: int) -> ImageFont.FreeTypeFont:
    """Elige la fuente. Prefiere las display del ticket (Shrikhand/Baloo 2,
    embebidas en app/assets/fonts, licencia OFL) y cae a DejaVu si faltan.

    En serverless la imagen base puede no traer DejaVu. `load_default(size)`
    devuelve una fuente escalable con ese tamano; sin el argumento seria una
    bitmap fija de 10px y el texto saldria ilegible en la boleta.
    """
    shrikhand = os.path.join(_ASSETS, "Shrikhand-Regular.ttf")
    baloo = os.path.join(_ASSETS, "Baloo2-Variable.ttf")
    try:
        return ImageFont.truetype(shrikhand, size)
    except Exception:
        pass
    for path in (baloo,
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default(size)


def _load_baloo(size: int) -> ImageFont.FreeTypeFont:
    """Baloo 2 (redonda amable) para etiquetas y datos del talon."""
    baloo = os.path.join(_ASSETS, "Baloo2-Variable.ttf")
    for path in (baloo,
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default(size)


def _truncate(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> str:
    """Corta el texto con puntos suspensivos para que quepa en max_w."""
    if not text:
        return ""
    if draw.textlength(text, font=font) <= max_w:
        return text
    while text and draw.textlength(text + "...", font=font) > max_w:
        text = text[:-1]
    return text + "..."


def _qr_image(data: str) -> Image.Image:
    # Nivel H (30% de correccion de error): la boleta se muestra desde un
    # telefono con brillo bajo o pasa por WhatsApp (recompresion); con M
    # (15%) los escaneos fallaban mucho mas en la puerta.
    qr = qrcode.QRCode(border=1, error_correction=qrcode.constants.ERROR_CORRECT_H)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    return img.resize((260, 260), Image.LANCZOS)


def _estrella(d: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill) -> None:
    """Destello de 4 puntas (el brillo del cartel de festival)."""
    k = 0.22
    pts = [
        (cx, cy - r),
        (cx + r * k, cy - r * k),
        (cx + r, cy),
        (cx + r * k, cy + r * k),
        (cx, cy + r),
        (cx - r * k, cy + r * k),
        (cx - r, cy),
        (cx - r * k, cy - r * k),
    ]
    d.polygon(pts, fill=fill)


def build_ticket_image(
    *,
    ticket_number: int,
    customer_name: str,
    event_name: str,
    starts_at: str,
    raw_token: str,
    venue_name: str,
    location: str | None = None,
) -> bytes:
    """Compone la imagen y devuelve bytes JPEG (W=900, H=500)."""
    W, H = _TICKET_W, _TICKET_H

    # --- Campo de fondo: indigo profundo con rayos sutiles de festival -----
    img = Image.new("RGB", (W, H), _INDIGO)
    d = ImageDraw.Draw(img, "RGBA")
    import math

    cx, cy = W // 2, H // 2
    for ang in range(0, 360, 45):
        a = math.radians(ang)
        d.polygon(
            [
                (cx, cy),
                (cx + math.cos(a) * W, cy + math.sin(a) * W),
                (cx + math.cos(a + math.pi / 8) * W, cy + math.sin(a + math.pi / 8) * W),
            ],
            fill=(255, 255, 255, 10),
        )

    # --- El ticket ambar (deja margenes de campo arriba y abajo) ------------
    tx0, ty0 = 36, 44
    tx1, ty1 = W - 36, H - 44
    # El talon derecho arranca aqui: perforacion, pie y sello lo comparten.
    perfo_x = W - 318
    d.rounded_rectangle([tx0, ty0, tx1, ty1], radius=36, fill=_AMBAR)
    # Luz cenital: banda clara arriba (borde contra la luz)
    d.rounded_rectangle(
        [tx0, ty0, tx1, ty0 + 26], radius=36, fill=_AMBAR_CLARO
    )
    d.rounded_rectangle(
        [tx0, ty0 + 26, tx1, ty1], radius=36, fill=_AMBAR
    )

    font_marca = _load_baloo(22)
    font_meta = _load_baloo(24)
    font_meta_b = _load_baloo(27)
    font_titulo = _load_font(58)  # Shrikhand: display jugosa del cartel
    font_nombre = _load_baloo(40)
    font_chica = _load_baloo(20)
    font_micro = _load_baloo(17)

    # --- Cabecera del ticket: marca + fecha ---------------------------------
    d.text((tx0 + 36, ty0 + 22), "T I C K E L O T", font=font_marca, fill=_INDIGO)
    # fecha a la derecha de la cabecera
    fecha = _truncate(d, starts_at or "", font_meta, 300)
    wfecha = d.textlength(fecha, font=font_meta)
    d.text((tx1 - 36 - wfecha, ty0 + 25), fecha, font=font_meta, fill=_TINTA_SUAVE)

    # --- Titulo del evento: la estrella del cartel (Shrikhand) --------------
    titulo = event_name or "TU BOLETA"
    # Shrikhand es mas ancha que DejaVu: reserva menos y parte en 2 lineas
    ancho_util = tx1 - tx0 - 290
    palabras = titulo.split()
    linea1, linea2 = titulo, ""
    if d.textlength(titulo, font=font_titulo) > ancho_util:
        linea1 = ""
        for p in palabras:
            prueba = (linea1 + " " + p).strip()
            if d.textlength(prueba, font=font_titulo) > ancho_util:
                break
            linea1 = prueba
        linea2 = titulo[len(linea1):].strip()
        # si aun asi no cabe la segunda linea, trunca
        if d.textlength(linea2, font=font_titulo) > ancho_util:
            linea2 = _truncate(d, linea2, font_titulo, ancho_util)
    d.text((tx0 + 36, ty0 + 72), linea1.upper(), font=font_titulo, fill=_INDIGO)
    if linea2:
        d.text((tx0 + 36, ty0 + 138), linea2.upper(), font=font_titulo, fill=_INDIGO)
        y_datos = ty0 + 222
    else:
        y_datos = ty0 + 168
    # subrayado con destello, como sello del cartel
    _estrella(d, tx0 + 48, y_datos - 12, 14, (255, 255, 255, 230))
    d.rounded_rectangle(
        [tx0 + 70, y_datos - 18, tx0 + 300, y_datos - 12],
        radius=3,
        fill=(74, 47, 5, 90),
    )

    # --- Datos del asistente (zona libre del ticket) ------------------------
    # Etiquetas micro en mayuscula + valores en tinta
    d.text((tx0 + 36, y_datos), "INVITADO", font=font_micro, fill=(74, 47, 5, 170))
    nombre = _truncate(d, customer_name or "", font_nombre, tx1 - tx0 - 420)
    d.text((tx0 + 36, y_datos + 26), nombre, font=font_nombre, fill=_TINTA)

    meta_y = y_datos + 84
    d.text((tx0 + 36, meta_y), f"Boleta #{ticket_number}", font=font_meta_b, fill=_TINTA_SUAVE)
    if location:
        lugar = _truncate(d, f"Lugar: {location}", font_chica, tx1 - tx0 - 420)
        d.text((tx0 + 36, meta_y + 38), lugar, font=font_chica, fill=(74, 47, 5, 200))
    d.text(
        (tx0 + 36, ty1 - 34),
        _truncate(
            d,
            "Presenta el QR en la entrada - entera con tu documento",
            font_chica,
            perfo_x - tx0 - 60,
        ),
        font=font_chica,
        fill=(74, 47, 5, 160),
    )

    # --- Talon derecho: perforacion punteada + QR sobre panel blanco --------
    # El QR va en posicion FIJA (W-300, 130) a 260px: el test guardian
    # compara esa region contra la referencia del token.
    dash_len, gap = 8, 9
    y = ty0 + 20
    while y < ty1 - 20:
        d.line(
            [(perfo_x, y), (perfo_x, min(y + dash_len, ty1 - 20))],
            fill=_CREMA,
            width=4,
        )
        y += dash_len + gap
    # muescas de troquel arriba/abajo sobre la perforacion
    d.ellipse([perfo_x - 16, ty0 - 16, perfo_x + 16, ty0 + 16], fill=_INDIGO)
    d.ellipse([perfo_x - 16, ty1 - 16, perfo_x + 16, ty1 + 16], fill=_INDIGO)

    qr = _qr_image(raw_token)
    # panel blanco detras del QR (el escaner necesita contraste real)
    d.rounded_rectangle(
        [W - 310, 120, W - 30, 400], radius=18, fill=(255, 255, 255, 255)
    )
    img.paste(qr, (W - 300, 130))
    # sello ADMIT ONE bajo el QR, centrado en el talon
    sello = "ADMIT ONE"
    wsello = d.textlength(sello, font=font_micro)
    talon_centro = (perfo_x + tx1) / 2
    d.text((talon_centro - wsello / 2, 410), sello, font=font_micro, fill=_INDIGO)

    # --- Burbujas de confeti detras de la perforacion (tipo Jazz Love Fest) -
    # Dibujadas AL FINAL pero en la zona del campo (fuera del ticket): nunca
    # tocan el QR ni el area del test guardian.
    for (bx, by, br, color) in [
        (24, 60, 14, _CONFETI[0]),
        (14, 240, 18, _CONFETI[1]),
        (30, 430, 12, _CONFETI[2]),
        (W - 16, 52, 12, _CONFETI[3]),
        (W - 22, 470, 16, _CONFETI[0]),
    ]:
        d.ellipse([bx - br, by - br, bx + br, by + br], fill=color)
    # media luna sobre el ticket, como sello del cartel
    d.arc([W // 2 - 26, ty0 - 34, W // 2 + 26, ty0 + 18], 200, 340, fill=_CREMA, width=4)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()
