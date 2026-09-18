"""Genera los íconos PNG de la PWA a partir del isotipo TicketFlow.

Diseño: ticket blanco con muescas laterales y franja violeta (misma
identidad que el favicon). Tres variantes:
  - any:      fondo transparente, ticket completo (instalador Android,
              pestaña del navegador).
  - maskable: fondo violeta full-bleed con el ticket dentro de la zona
              segura (Android enmascara a círculo/squircle).
  - apple:    full-bleed 180px (iOS ignora maskable y recorta esquinas).

Se dibuja a 4x y se reduce con LANCZOS para bordes suaves.
Uso: backend/.venv/Scripts/python.exe scripts/generate_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "frontend" / "public" / "icons"
SS = 4  # factor de supersampling

WHITE = (255, 255, 255, 255)
VIOLET = (124, 58, 237, 255)  # #7c3aed
TRANSPARENT = (0, 0, 0, 0)


def draw_ticket(im: Image.Image, size: int, ticket_w: int, notch_fill) -> None:
    """Dibuja el ticket centrado en `im` (lienzo size x size ya con fondo)."""
    d = ImageDraw.Draw(im)
    cx = cy = size // 2
    ticket_h = round(ticket_w * 15 / 14)  # proporción del favicon
    x0, y0 = cx - ticket_w // 2, cy - ticket_h // 2
    x1, y1 = x0 + ticket_w, y0 + ticket_h

    # Cuerpo del ticket
    d.rounded_rectangle([x0, y0, x1, y1], radius=round(ticket_w * 0.07), fill=WHITE)

    # Muescas laterales (circulitos recortados en el centro de cada lado)
    nr = round(ticket_w * 0.11)
    for ncx in (x0, x1):
        d.ellipse([ncx - nr, cy - nr, ncx + nr, cy + nr], fill=notch_fill)

    # Franja violeta vertical al centro
    sw = max(2, round(ticket_w * 0.11))
    d.rectangle([cx - sw // 2, y0, cx + sw // 2, y1], fill=VIOLET)


def make_icon(size: int, *, maskable: bool) -> Image.Image:
    n = size * SS
    if maskable:
        im = Image.new("RGBA", (n, n), VIOLET)
        draw_ticket(im, n, ticket_w=round(n * 0.50), notch_fill=VIOLET)
    else:
        im = Image.new("RGBA", (n, n), TRANSPARENT)
        draw_ticket(im, n, ticket_w=round(n * 0.64), notch_fill=TRANSPARENT)
    return im.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    targets = {
        "icon-192.png": (192, False),
        "icon-512.png": (512, False),
        "icon-maskable-192.png": (192, True),
        "icon-maskable-512.png": (512, True),
        "apple-touch-icon.png": (180, True),  # iOS: full-bleed, opaco
    }
    for name, (size, maskable) in targets.items():
        icon = make_icon(size, maskable=maskable)
        if maskable:  # aplastar alfa: el fondo debe ser opaco
            bg = Image.new("RGBA", icon.size, VIOLET)
            bg.alpha_composite(icon)
            icon = bg
        icon.save(OUT / name, optimize=True)
        print(f"  {name}: {size}x{size} {'maskable' if maskable else 'any'}")


if __name__ == "__main__":
    main()
