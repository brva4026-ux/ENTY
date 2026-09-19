"""Drenador del outbox de push (mig 014).

Las notificaciones in-app nacen en triggers SQL (mig 012/014) dentro de la
transacción de negocio; el push real se envía FUERA de esa transacción: el
trigger deja la carta en push_outbox y este worker la drena con el mismo
send_web_push de la apertura de puertas.

Garantías:
- Sobrevive reinicios: lo pendiente se drena al arrancar y en cada tick.
- Un dispositivo muerto (404/410) no rompe a los demás; su suscripción se
  limpia como en notify_venue.
- Un fallo de red en el envío NO marca procesada la carta: el próximo tick
  reintenta. El timeout acota cuánto puede colgar cada drenada.
- Si VAPID no está configurado, el worker NO arranca (push deshabilitado no
  debe ruido; las notificaciones in-app siguen funcionando igual).

Serverless (Vercel): el proceso es efímero, así que el intervalo es corto y
cada request que toque el API drena lo que encuentre — el coste extra es una
query indexada (idx_push_outbox_pending) que casi siempre devuelve 0 filas.
"""
import asyncio
import logging

import psycopg
from psycopg.rows import dict_row

from app.core.config import get_settings
from app.core.pusher import send_web_push

logger = logging.getLogger("ticketflow.push")

# Cada carta se intenta por hayas visto cuántas veces antes de rendirse: evita
# envenenar el drenaje con una notificación que ningún push service acepta.
MAX_ATTEMPTS_PER_TICK = 50  # tope de cartas por tick (latencia acotada)


async def _drain_once(db) -> int:
    """Drena UNA tanda de cartas pendientes. Devuelve cuántas procesó.

    `db` es una conexión ya prestada del pool (autocommit): cada carta se
    marca en su propia transacción implícita — una que falle no revierte a
    las demás.
    """
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT o.id AS outbox_id, n.user_id, n.kind, n.title, n.body, n.link
            FROM push_outbox o
            JOIN notifications n ON n.id = o.notification_id
            WHERE o.processed_at IS NULL
            ORDER BY o.id
            LIMIT %s
            """,
            (MAX_ATTEMPTS_PER_TICK,),
        )
        letters = await cur.fetchall()
    if not letters:
        return 0

    # Suscripciones de TODOS los destinatarios de esta tanda, en una query.
    user_ids = sorted({l["user_id"] for l in letters if l["user_id"]})
    if not user_ids:
        # Notificaciones sin destinatario válido: se marcan procesadas para
        # no quedar eternamente pendientes.
        async with db.cursor() as cur:
            await cur.execute(
                "UPDATE push_outbox SET processed_at=now() WHERE id = ANY(%s)",
                ([l["outbox_id"] for l in letters],),
            )
        return len(letters)

    subs_by_user: dict[int, list[dict]] = {}
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT ps.id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth
            FROM push_subscriptions ps
            JOIN users u ON u.id = ps.user_id AND u.is_active
            WHERE ps.user_id = ANY(%s)
            """,
            (user_ids,),
        )
        for row in await cur.fetchall():
            subs_by_user.setdefault(row["user_id"], []).append(row)

    settings = get_settings()
    dead_ids: set[int] = set()
    sent = 0

    async def _send(letter: dict) -> bool:
        """Envía la carta a todos los dispositivos del usuario. True = procesada."""
        subs = subs_by_user.get(letter["user_id"], [])
        if not subs:
            return True  # nadie a quien avisar: la carta se cumple igual
        payload = {
            "title": letter["title"],
            "body": letter["body"],
            # El click de la notificación aterriza donde la notificación in-app
            # lo haría (mismo link del feed).
            "url": letter["link"] or "/",
            "tag": f"tf-{letter['kind']}",
        }
        ok_any = False
        for sub in subs:
            res = await send_web_push(
                sub["endpoint"],
                sub["p256dh"],
                sub["auth"],
                vapid_private_b64=settings.vapid_private_key_b64,
                vapid_subject=settings.vapid_subject,
                payload=payload,
            )
            if res.dead:
                dead_ids.add(sub["id"])
            elif res.ok:
                ok_any = True
        # Procesada si al menos un dispositivo la recibió (o solo había
        # muertos, que ya no volverán a recibir nada).
        return ok_any or bool(subs)

    try:
        results = await asyncio.wait_for(
            asyncio.gather(*(_send(l) for l in letters)), timeout=20.0
        )
    except asyncio.TimeoutError:
        # El drenaje nunca puede colgar el API: lo que no alcanzó se reintenta.
        return 0

    done_ids = [l["outbox_id"] for l, ok in zip(letters, results) if ok]
    if done_ids:
        async with db.cursor() as cur:
            await cur.execute(
                "UPDATE push_outbox SET processed_at=now() WHERE id = ANY(%s)",
                (done_ids,),
            )
    if dead_ids:
        async with db.cursor() as cur:
            await cur.execute(
                "DELETE FROM push_subscriptions WHERE id = ANY(%s)",
                (sorted(dead_ids),),
            )
    return len(done_ids)


async def drain_push_outbox() -> None:
    """Drena con el pool global (o conexión efímera en serverless). Nunca
    lanza: el fallo de una pasada solo queda en el log; el próximo tick
    reintenta."""
    from app.core.config import get_settings
    import app.core.db as dbmod

    settings = get_settings()
    if not (settings.vapid_public_key_b64 and settings.vapid_private_key_b64):
        return  # push deshabilitado: nada que hacer

    try:
        if dbmod._SERVERLESS:
            conn = await psycopg.AsyncConnection.connect(
                settings.database_url, **dbmod._CONNECT_KWARGS
            )
            try:
                processed = await _drain_once(conn)
                await conn.commit()
            finally:
                await conn.close()
        else:
            if dbmod.pool is None or dbmod.pool.closed:
                return  # el pool aún no existe: el próximo tick reintenta
            async with dbmod.pool.connection() as db:
                processed = await _drain_once(db)
                await db.commit()
        if processed:
            logger.info("push outbox: %d notificaciones enviadas", processed)
    except Exception as e:  # noqa: BLE001 — el worker jamás tumba el proceso
        logger.warning("push outbox: drenaje falló (%s); reintenta en el próximo tick", e)


async def push_outbox_worker(stop: asyncio.Event) -> None:
    """Loop del worker: drena al arrancar y cada INTERVAL segundos.

    En serverless el proceso muere entre requests, así que el intervalo es
    corto; en un despliegue durable el mismo valor está bien (el costo de un
    tick vacío es una query indexada que devuelve 0 filas).
    """
    INTERVAL = 15
    await drain_push_outbox()  # primera pasada inmediata (arranque)
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=INTERVAL)
        except asyncio.TimeoutError:
            await drain_push_outbox()
