"""Política de contraseñas: una sola definición para toda la plataforma.

Los requisitos (≥8, mayúscula, minúscula, número) ya se le prometían al
usuario en el registro (el medidor del Register los pedía), pero el backend
solo exigía longitud: por la API una contraseña "aaaaaaaa" era válida. Aquí
queda una única función reutilizada por register, change-password y el reset
del admin, de modo que lo que la UI promete == lo que el backend exige.
"""
import re
from typing import Annotated

from pydantic import StringConstraints

UPPER = re.compile(r"[A-ZÁÉÍÓÚÑ]")
LOWER = re.compile(r"[a-záéíóúñ]")
DIGIT = re.compile(r"[0-9]")

MIN_LENGTH = 8
MAX_LENGTH = 128

# Mensaje de requisito por clave: lo usa la UI para pintar cada ítem en
# verde/rojo y el backend para construir el 422 en español.
REQUIREMENTS = {
    "length": f"mínimo {MIN_LENGTH} caracteres",
    "upper": "una mayúscula",
    "lower": "una minúscula",
    "digit": "un número",
}


def missing_requirements(password: str) -> list[str]:
    """Claves de los requisitos que la contraseña NO cumple, en orden estable."""
    missing: list[str] = []
    if len(password) < MIN_LENGTH:
        missing.append("length")
    if not UPPER.search(password):
        mayus = "upper"
        missing.append(mayus)
    if not LOWER.search(password):
        missing.append("lower")
    if not DIGIT.search(password):
        missing.append("digit")
    return missing


def password_error_detail(password: str) -> str | None:
    """Mensaje 422 completo si la contraseña es débil; None si es válida."""
    missing = missing_requirements(password)
    if not missing:
        return None
    items = [REQUIREMENTS[k] for k in missing]
    if len(items) == 1:
        return f"La contraseña necesita {items[0]}."
    return f"La contraseña necesita {', '.join(items[:-1])} y {items[-1]}."


def check_password_strength(value: str) -> str:
    """Validador pydantic: lanza ValueError con el mensaje en español."""
    detail = password_error_detail(value)
    if detail:
        raise ValueError(detail)
    return value


# Tipo anotado listo para usar en los schemas: fuerza política + límites.
# La complejidad se aplica con field_validator en cada schema (el mensaje del
# error debe ser el nuestro en español, no el genérico de StringConstraints).
PasswordStr = Annotated[
    str,
    StringConstraints(min_length=MIN_LENGTH, max_length=MAX_LENGTH),
]
