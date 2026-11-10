"""Rate limiting por IP respaldado en la DB (funciona en serverless).

El problema (Ley de Tesler, hallazgo del deploy): los límites vivían en dicts
en memoria del proceso. En Vercel cada invocación puede caer en otra instancia
y el dict muere en cada cold start, así que los límites "existían" en el código
pero en producción no frenaban nada. La mig 016 arregló esto para /auth/login;
este módulo generaliza el patrón (mig 041: tabla `rate_limit_hits` + función
`rate_limit_hit`) para el resto de endpoints.

La clave (`scope:ip`) aísla cada endpoint: agotar el cupo del catálogo no
consume el del checkout. La IP sale de los headers de reenvío del edge
(x-real-ip, luego x-forwarded-for), igual que en auth/public.

Fail-open deliberado: si la DB no responde, la petición pasa. El límite es
defensa en profundidad, nunca una llave que deje fuera a usuarios legítimos
por un incidente de infraestructura.
"""
from __future__ import annotations

import psycopg
from fastapi import HTTPException, Request, status


def client_ip(request: Request) -> str:
    """IP real del cliente detrás del proxy (Vercel).

    `request.client.host` es la edge, no la persona: sin los headers de
    reenvío TODOS los invitados compartirían un cubo y el límite se agotaría
    con unas decenas de usuarios concurrentes.
    """
    fwd = request.headers.get("x-forwarded-for", "")
    return (
        request.headers.get("x-real-ip")
        or (fwd.split(",")[0].strip() if fwd else "")
        or (request.client.host if request.client else "unknown")
    )


async def enforce_rate_limit(
    request: Request,
    db: psycopg.AsyncConnection,
    *,
    scope: str,
    max_hits: int,
    window_seconds: int,
    message: str = "Demasiadas peticiones",
) -> None:
    """Cuenta un impacto de `scope` para esta IP; lanza 429 si excede el cupo.

    La ventana es deslizante (`now() - window_seconds`) y el contador vive en
    la DB, compartido por todas las instancias. Un rechazo NO se registra (si
    contara, la ventana se llenaría de los propios rechazos y el bloqueo se
    autoextendería).
    """
    key = f"{scope}:{client_ip(request)}"
    try:
        async with db.cursor() as cur:
            await cur.execute(
                "SELECT rate_limit_hit(%s, %s, %s) AS allowed",
                (key, max_hits, window_seconds),
            )
            row = await cur.fetchone()
        allowed = bool(row["allowed"]) if row else True
    except psycopg.Error:
        allowed = True  # fail-open: un límite caído no debe tumbar la app

    if not allowed:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, message)
