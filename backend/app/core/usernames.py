"""Nombres de usuario: una sola normalización para registro, perfil y login.

El usuario identifica a la PERSONA; el nombre del negocio identifica su espacio
de trabajo. Son datos distintos y se editan por separado.

Reglas:
  * Formato: 3..32 caracteres, ``[a-z0-9._-]`` (el mismo CHECK de la DB).
  * Se guarda en minúsculas y sin tildes. ``@`` inicial es decorativo: al
    normalizar se descarta.
  * Al generar uno para una cuenta nueva la base sale del nombre del negocio o,
    si no hay, del nombre completo. NUNCA del correo, teléfono o documento.
  * Si la base no produce un usuario válido se usa ``usuario`` y se prueban
    variantes acotadas (``usuario-2``, ``usuario-3``...).
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator

USERNAME_MIN = 3
USERNAME_MAX = 32
USERNAME_RE = re.compile(r"^[a-z0-9._-]{3,32}$")
_FALLBACK = "usuario"
_SEPARATORS = "._-"


def normalize_username(value: str) -> str:
    """Normaliza la entrada de una persona: ``@``, tildes y mayúsculas.

    No convierte espacios ni símbolos en separadores: quien elige su usuario
    recibe un error de formato si escribe algo fuera del alfabeto permitido.
    La generación automática sí usa :func:`username_base` para construir una
    base limpia.
    """
    raw = (value or "").strip()
    if raw.startswith("@"):
        raw = raw[1:]
    raw = unicodedata.normalize("NFKD", raw)
    raw = "".join(ch for ch in raw if not unicodedata.combining(ch))
    return raw.lower()


def username_base(source: str) -> str:
    """Base generada a partir de un nombre (nunca de un correo).

    Convierte cualquier run de caracteres no permitidos en un punto, colapsa
    separadores y recorta a 32. Si no queda una base de al menos 3 caracteres,
    devuelve ``usuario``.
    """
    base = normalize_username(source)
    base = re.sub(r"[^a-z0-9._-]+", ".", base)
    base = re.sub(r"[._-]{2,}", ".", base)
    base = base.strip(_SEPARATORS)
    if len(base) < USERNAME_MIN:
        return _FALLBACK
    base = base[:USERNAME_MAX].rstrip(_SEPARATORS)
    return base or _FALLBACK


def username_candidates(base: str, limit: int = 50) -> Iterator[str]:
    """Variantes acotadas para resolver colisiones sin salir del formato."""
    yield base
    for n in range(2, limit + 1):
        suffix = f"-{n}"
        stem = base[: USERNAME_MAX - len(suffix)].rstrip(_SEPARATORS)
        yield f"{stem or _FALLBACK}{suffix}"


def is_valid_username(value: str) -> bool:
    return bool(USERNAME_RE.fullmatch(value or ""))
