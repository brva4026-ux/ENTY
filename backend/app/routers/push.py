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
from app.deps import ensure_roles, get_current_user
from app.schemas import PushSubscribeRequest, PushUnsubscribeRequest

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
                          created_at=now()
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
