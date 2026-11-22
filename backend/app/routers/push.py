"""Web Push: suscripción de dispositivos y llave pública VAPID.

- GET  /push/public-key  -> clave pública VAPID (público; sin ella el
  navegador no puede suscribirse).
- POST /push/subscribe   -> guarda/renueva la suscripción del dispositivo del
  usuario autenticado (una fila por dispositivo: endpoint es único).
- POST /push/unsubscribe -> elimina la suscripción (al desactivar "avisarme").

El envío real ocurre en lifecycle.go_live (published -> live): ver
app.core.pusher.notify_venue. El estado "¿estoy suscrito?" no necesita
endpoint: el frontend lo sabe localmente vía pushManager.getSubscription().
"""
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.config import get_settings
from app.core.db import get_db
from app.core.pusher import send_web_push
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    PushStatusOut,
    PushSubscribeRequest,
    PushTestOut,
    PushTestRequest,
    PushUnsubscribeRequest,
)

router = APIRouter(prefix="/push", tags=["push"])


@router.get("/public-key")
async def public_key() -> dict[str, object]:
    """Clave pública VAPID en base64url (sin padding), tal cual la espera
    `pushManager.subscribe({ applicationServerKey })`.

    Devuelve enabled=false si no hay claves configuradas: la UI oculta el
    control en lugar de ofrecer algo que no funcionará.
    """
    settings = get_settings()
    enabled = bool(settings.vapid_public_key_b64 and settings.vapid_private_key_b64)
    return {"public_key": settings.vapid_public_key_b64 or None, "enabled": enabled}


@router.post("/subscribe", status_code=status.HTTP_204_NO_CONTENT)
async def subscribe(
    body: PushSubscribeRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    request: Request,
) -> None:
    """Guarda la suscripción push del dispositivo actual.

    `endpoint`/`keys` son el shape exacto que entrega pushManager.subscribe().
    La suscripción se asocia a la venue indicada (el portero puede trabajar en
    varias; avisa la que elija aquí).
    """
    ensure_roles(user, body.venue_id, "super_admin", "admin", "promotor", "bouncer")

    user_agent = (request.headers.get("user-agent") or "")[:250]
    async with db.cursor() as cur:
        # La venue debe existir (evita suscribirse a ids ajenos inexistentes).
        await cur.execute("SELECT 1 FROM venues WHERE id=%s", (body.venue_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Venue no encontrada")

        await cur.execute(
            """
            INSERT INTO push_subscriptions (user_id, venue_id, endpoint, p256dh, auth, user_agent)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (endpoint)
            DO UPDATE SET user_id=EXCLUDED.user_id,
                          venue_id=EXCLUDED.venue_id,
                          p256dh=EXCLUDED.p256dh,
                          auth=EXCLUDED.auth,
                          user_agent=EXCLUDED.user_agent,
                          last_seen_at=now()
            """,
            (user["id"], body.venue_id, body.endpoint, body.keys.p256dh, body.keys.auth, user_agent),
        )
        await db.commit()
    return None


@router.post("/unsubscribe", status_code=status.HTTP_204_NO_CONTENT)
async def unsubscribe(
    body: PushUnsubscribeRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
) -> None:
    """Elimina la suscripción del dispositivo (por endpoint exacto).

    Solo borra suscripciones del propio usuario: un endpoint ajeno no puede
    cancelar la suscripción de otro."""
    async with db.cursor() as cur:
        await cur.execute(
            "DELETE FROM push_subscriptions WHERE endpoint=%s AND user_id=%s",
            (body.endpoint, user["id"]),
        )
        await db.commit()
    return None


@router.get("/status", response_model=PushStatusOut)
async def push_status(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    endpoint: str | None = None,
    permission: str = "default",
    subscribed: bool = False,
) -> PushStatusOut:
    """Estado REAL de este dispositivo.

    `subscribed` lo aporta el navegador (es el único que ve pushManager).
    `registered` NO: solo es true si el endpoint exacto está guardado para
    esta cuenta y esta venue. Esa es la diferencia entre "el interruptor se
    ve encendido" y "el servidor puede enviarte un aviso".
    """
    settings = get_settings()
    enabled = bool(settings.vapid_public_key_b64 and settings.vapid_private_key_b64)
    row = None
    if endpoint:
        async with db.cursor() as cur:
            await cur.execute(
                """SELECT id, user_agent, last_seen_at
                   FROM push_subscriptions
                   WHERE endpoint=%s AND user_id=%s AND venue_id=%s""",
                (endpoint, user["id"], venue_id),
            )
            row = await cur.fetchone()
    return PushStatusOut(
        server_enabled=enabled,
        supported=True,
        permission=permission if permission in {"default", "granted", "denied"} else "default",
        subscribed=subscribed,
        registered=bool(row),
        endpoint=endpoint,
        registered_at=row["last_seen_at"] if row else None,
        device=(row["user_agent"] if row else None),
    )


@router.post("/test", response_model=PushTestOut)
async def push_test(
    body: PushTestRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
) -> PushTestOut:
    """Envía un aviso de prueba SOLO al endpoint que lo solicita.

    Web Push no devuelve confirmación de entrega: `sent=true` significa que
    el servicio push aceptó el mensaje, no que el teléfono lo mostró.
    """
    ensure_roles(user, body.venue_id, "super_admin", "admin", "promotor", "bouncer")
    settings = get_settings()
    if not (settings.vapid_public_key_b64 and settings.vapid_private_key_b64):
        return PushTestOut(
            sent=False,
            detail="El servidor no tiene configurado el envío de avisos push.",
        )
    async with db.cursor() as cur:
        await cur.execute(
            """SELECT id, endpoint, p256dh, auth
               FROM push_subscriptions
               WHERE endpoint=%s AND user_id=%s AND venue_id=%s""",
            (body.endpoint, user["id"], body.venue_id),
        )
        sub = await cur.fetchone()
    if not sub:
        return PushTestOut(
            sent=False,
            detail="Este dispositivo no está registrado para esta organización.",
        )
    result = await send_web_push(
        sub["endpoint"],
        sub["p256dh"],
        sub["auth"],
        vapid_private_b64=settings.vapid_private_key_b64,
        vapid_subject=settings.vapid_subject,
        payload={
            "title": "Aviso de prueba · Enty",
            "body": "Si ves este aviso, este dispositivo recibe los avisos de puerta.",
            "url": "/perfil?tab=preferencias",
            "tag": f"tf-test-{sub['id']}",
        },
    )
    if result.dead:
        async with db.cursor() as cur:
            await cur.execute("DELETE FROM push_subscriptions WHERE id=%s", (sub["id"],))
            await db.commit()
        return PushTestOut(
            sent=False,
            status_code=result.status_code,
            detail="El navegador invalidó la suscripción. Vuelve a activar los avisos.",
        )
    return PushTestOut(
        sent=bool(result.ok),
        status_code=result.status_code,
        detail=(
            "Envío solicitado al servicio push. No podemos confirmar la "
            "recepción en el dispositivo."
            if result.ok
            else f"El servicio push rechazó el envío ({result.error or result.status_code})."
        ),
    )
