#!/usr/bin/env python3
"""Genera el video de fondo de la pantalla de ingreso (Enty).

No es material de stock: el fondo se SINTETIZA con la paleta y los motivos
de la marca (ver frontend/public/brand/guidelines.html):

  - negro profundo #0B0B0F como lienzo;
  - destellos de luz morados #7C3AED en las esquinas que derivan lento;
  - verde neón #00E6AB y rosa neón #FF2D98 como energía gráfica, muy tenues;
  - un grid modular tenue (eco del QR de la boleta) que respira;
  - la estrella de cuatro puntas de la marca, titilando.

Todo se anima con senos de periodo igual a la duración del clip, así el loop
es PERFECTO: el último frame engancha con el primero sin costura. El grano
estático evita el banding de los degradados sobre negro.

Uso:
    python3 scripts/generate_login_video.py

Salida (en frontend/public/media/):
    login-bg.mp4          H.264, para Safari/iOS
    login-bg.webm         VP9, más liviano para el resto
    login-bg-poster.jpg   primer frame, para el atributo poster
"""

from __future__ import annotations

import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# --- Parámetros del clip -------------------------------------------------
WIDTH, HEIGHT = 1280, 720
FPS = 24
DURATION = 8.0  # segundos; periodo de TODAS las animaciones => loop perfecto
FRAMES = int(FPS * DURATION)

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "frontend" / "public" / "media"
TMP_DIR = Path("/tmp/enty-login-frames")

# --- Paleta (misma que tokens.css / guidelines.html) ---------------------
BASE = np.array([11, 11, 15], dtype=np.float64)  # #0B0B0F
PURPLE = np.array([124, 58, 237], dtype=np.float64)  # #7C3AED
GREEN = np.array([0, 230, 171], dtype=np.float64)  # #00E6AB
PINK = np.array([255, 45, 152], dtype=np.float64)  # #FF2D98
WHITE = np.array([245, 245, 247], dtype=np.float64)  # #F5F5F7

# -------------------------------------------------------------------------
# OTIMIZACIÓN 1: Tabla de lookup para sparkles (pre-computar senos)
# En lugar de calcular math.sin() 16 veces por frame (128 total), lo hacemos
# una sola vez al inicio y luego hacemos lookup por índice de frame.
# -------------------------------------------------------------------------
_rng = np.random.default_rng(7)
_SPARKLES = [
    (
        float(_rng.uniform(0.08, 0.92)) * WIDTH,
        float(_rng.uniform(0.10, 0.90)) * HEIGHT,
        float(_rng.uniform(7.0, 13.0)),
        float(_rng.uniform(0.0, 2 * math.pi)),
        1 + int(_rng.uniform(0, 2)),
        int(_rng.uniform(0, 3)),
    )
    for _ in range(16)
]
_SPARK_COLORS = [WHITE, np.array([217, 182, 255]), GREEN, PINK]

# Pre-compute sparkle intensities for every frame and every sparkle.
# sparkle_intensities[sparkle_index][frame_index] = intensity (o 0 si < 0.02)
_sparkle_intensities: list[list[float]] = []
for _cx, _cy, _size, _phase, _k, _ci in _SPARKLES:
    intensities: list[float] = []
    for i in range(FRAMES):
        t = i / FPS
        tw = 0.5 + 0.5 * math.sin(2 * math.pi * _k * t / DURATION + _phase)
        tw = tw**4  # picos cortos: destello, no lámpara
        intensities.append(tw if tw >= 0.02 else 0.0)
    _sparkle_intensities.append(intensities)

# -------------------------------------------------------------------------
# OTIMIZACIÓN 2: Incremento angular incremental
# En lugar de recomputar w = 2*pi*t/DURATION cada frame, usamos un paso
# incremental angle_step = 2*pi/FRAMES y vamos acumulando el ángulo.
# Esto evita la multiplicación y división por frame.
# -------------------------------------------------------------------------
ANGLE_STEP = 2.0 * math.pi / FRAMES

# Pre-compute glow parameters that depend only on the angular phase `w`.
# Las esquinas moradas usan senos/cosenos de `w`, así que pre-computamos
# sus posiciones y sigma ya que no cambian (solo la amplitud varia con w).
# Pero para simplificar, mantemos la función _glow y solo optimizamos el bucle
# principal usando el ángulo incremental.

def _grid():
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float64)
    return xx, yy


XX, YY = _grid()

# Grid modular (eco del QR de la boleta): celdas y su parche gaussiano
# precalculado. Solo se dibuja ~55% de las celdas, elegidas por hash estable.
CELL = 34.0
_QR_RAD = int(CELL * 2.6)
_qy, _qx = np.mgrid[-_QR_RAD:_QR_RAD, -_QR_RAD:_QR_RAD].astype(np.float64)
_QR_PATCH = np.exp(-(_qx**2 + _qy**2) / (2.0 * (CELL * 0.42) ** 2))
_QR_CELLS = []
for _r in range(int(math.ceil(HEIGHT / CELL)) + 2):
    for _c in range(int(math.ceil(WIDTH / CELL)) + 2):
        _h = math.sin(_r * 73.13 + _c * 19.77) * 43758.5453
        _frac = _h - math.floor(_h)
        if _frac >= 0.45:
            _QR_CELLS.append((_c * CELL, _r * CELL, _frac))


def _glow(cx: float, cy: float, sigma: float) -> np.ndarray:
    """Mancha radial gaussiana, normalizada a 0..1 en su centro."""
    d2 = (XX - cx) ** 2 + (YY - cy) ** 2
    return np.exp(-d2 / (2.0 * sigma * sigma))


def _star(cx: float, cy: float, size: float, weight: float) -> np.ndarray:
    """Estrella de cuatro puntas (la del logo): dos barras finas cruzadas."""
    dx = np.abs(XX - cx)
    dy = np.abs(YY - cy)
    core = np.exp(-(dx**2 + dy**2) / (2.0 * (size * 0.9) ** 2))
    bar_v = np.exp(-(dx**2) / (2.0 * (size * 0.22) ** 2)) * np.exp(
        -dy / (size * 2.6)
    )
    bar_h = np.exp(-(dy**2) / (2.0 * (size * 0.22) ** 2)) * np.exp(
        -dx / (size * 2.6)
    )
    return (core + bar_v + bar_h) * weight


def _qr_field(t: float) -> np.ndarray:
    """Grid modular tenue que respira: eco del QR de la boleta.

    Cada celda titila con su propia fase (derivada de un hash estable) y el
    grid completo se desplaza muy poco. Fase = 2πk·t/T con k entero => loop.

    Se estampa un parche local por celda (el mismo gaussiano cacheado,
    multiplicado por el pulso) en vez de evaluar el gaussiano sobre el frame
    completo: ~500 celdas sobre 921k px sería absurdo; así son parches de 88².
    """
    field = np.zeros((HEIGHT, WIDTH), dtype=np.float64)
    off_x = 6.0 * math.sin(2 * math.pi * t / DURATION)
    off_y = 5.0 * math.cos(2 * math.pi * t / DURATION)
    rad = _QR_RAD
    for cx, cy, frac in _QR_CELLS:
        phase = frac * 2 * math.pi
        k = 1 + int(frac * 2)  # 1 o 2 ciclos por loop
        pulse = 0.5 + 0.5 * math.sin(2 * math.pi * k * t / DURATION + phase)
        if pulse < 0.02:
            continue
        px = int(round(cx + off_x))
        py = int(round(cy + off_y))
        x0, x1 = px - rad, px + rad
        y0, y1 = py - rad, py + rad
        # recorte del parche a los límites del frame
        sx0, sx1 = max(0, x0), min(WIDTH, x1)
        sy0, sy1 = max(0, y0), min(HEIGHT, y1)
        if sx0 >= sx1 or sy0 >= sy1:
            continue
        field[sy0:sy1, sx0:sx1] += (
            _QR_PATCH[sy0 - y0 : sy1 - y0, sx0 - x0 : sx1 - x0] * pulse
        )
    return field


def render_frame(i: int, w: float) -> np.ndarray:
    """Renderiza un frame dado el ángulo `w` pre-computado.

    Args:
        i: índice del frame (0..FRAMES-1)
        w: ángulo en radianes (2*pi*i/DURATION), pre-computado por el caller
    """
    img = np.zeros((HEIGHT, WIDTH, 3), dtype=np.float64)

    # 1. Destellos de esquina (el grueso de la atmósfera).
    # Usamos el `w` pre-computado en lugar de recomputarlo.
    purple_a = _glow(
        WIDTH * (0.26 + 0.10 * math.sin(w)),
        HEIGHT * (0.28 + 0.09 * math.cos(w)),
        WIDTH * 0.34,
    )
    purple_b = _glow(
        WIDTH * (0.80 + 0.08 * math.sin(w + 2.1)),
        HEIGHT * (0.76 + 0.07 * math.cos(w + 1.3)),
        WIDTH * 0.38,
    )
    green = _glow(
        WIDTH * (0.94 + 0.05 * math.sin(w + 4.0)),
        HEIGHT * (0.18 + 0.06 * math.cos(w + 0.7)),
        WIDTH * 0.24,
    )
    pink = _glow(
        WIDTH * (0.06 + 0.05 * math.sin(w + 1.7)),
        HEIGHT * (0.92 + 0.05 * math.cos(w + 3.4)),
        WIDTH * 0.22,
    )

    img += purple_a[..., None] * PURPLE * 0.42
    img += purple_b[..., None] * PURPLE * 0.36
    img += green[..., None] * GREEN * 0.10
    img += pink[..., None] * PINK * 0.09

    # 2. Grid modular (QR): muy tenue, tinte lavanda.
    qr = _qr_field(i)
    qr = np.clip(qr, 0.0, 1.0)
    img += qr[..., None] * np.array([150, 120, 220]) * 0.055

    # 3. Estrellas de la marca titilando.
    # Usamos la tabla pre-computada en lugar de calcular sin() cada frame.
    for idx, (cx, cy, size, phase, k, ci) in enumerate(_SPARKLES):
        tw = _sparkle_intensities[idx][i]
        if tw < 0.02:
            continue
        img += _star(cx, cy, size, tw * 0.9)[..., None] * _SPARK_COLORS[ci]

    # 4. Lienzo negro de la marca por debajo de la luz (screen/add sobre base).
    img = BASE + img

    # 5. Viñeta: hunde las esquinas para que la tarjeta respire en el centro.
    vx = (XX / WIDTH - 0.5) * 2.0
    vy = (YY / HEIGHT - 0.5) * 2.0
    vign = 1.0 - 0.42 * np.clip(vx**2 + vy**2, 0.0, 1.6) / 1.6
    img *= vign[..., None]

    return img


# Grano estático (mismo en todos los frames: no rompe el loop y mata el banding).
_GRAIN = _rng.normal(0.0, 3.2, size=(HEIGHT, WIDTH, 1))


def main() -> int:
    if TMP_DIR.exists():
        for p in TMP_DIR.glob("*.png"):
            p.unlink()
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[*] Renderizando {FRAMES} frames a {WIDTH}x{HEIGHT}@{FPS}...")

    # Bucle principal: iteramos sobre frames, acumulando el ángulo incremental.
    # w empieza en 0 y aumentamos ANGLE_STEP cada iteración.
    w = 0.0
    for i in range(FRAMES):
        img = render_frame(i, w) + _GRAIN
        np.clip(img, 0, 255, out=img)
        Image.fromarray(img.astype(np.uint8)).save(
            TMP_DIR / f"f{i:04d}.png", optimize=False
        )
        w += ANGLE_STEP  # incremental angle update
        if i % 24 == 0:
            print(f"    frame {i}/{FRAMES}")

    mp4 = OUT_DIR / "login-bg.mp4"
    webm = OUT_DIR / "login-bg.webm"
    poster = OUT_DIR / "login-bg-poster.jpg"

    print("[*] Codificando H.264 (mp4)...")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-framerate",
            str(FPS),
            "-i",
            str(TMP_DIR / "f%04d.png"),
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-crf",
            "24",
            "-preset",
            "medium",  # OTIMIZACIÓN: changed from veryslow to medium
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            str(mp4),
        ],
        check=True,
    )

    print("[*] Codificando VP9 (webm)...")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-framerate",
            str(FPS),
            "-i",
            str(TMP_DIR / "f%04d.png"),
            "-c:v",
            "libvpx-vp9",
            "-crf",
            "34",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-row-mt",
            "1",
            "-an",
            str(webm),
        ],
        check=True,
    )

    print("[*] Extrayendo poster...")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(TMP_DIR / "f0000.png"),
            "-q:v",
            "4",
            str(poster),
        ],
        check=True,
    )

    for f in (mp4, webm, poster):
        print(f"    {f.relative_to(ROOT)}  {f.stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())