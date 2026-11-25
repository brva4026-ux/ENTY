"""Outbox de push (mig 014): escribir notificación = dejar push pendiente.

Los triggers de negocio llaman a notify_user/notify_venue_admins; desde la
014 esas funciones también insertan en push_outbox, en la MISMA transacción.
Aquí se verifica el contrato de las funciones SQL (no el worker, que necesita
VAPID y red): una llamada a notify_user produce notificación + carta
pendiente, y notify_venue_admins una carta por admin.
"""


def test_notify_user_writes_outbox_letter(db, dbcur, world):
    venue = world["venue_a"]
    user = world["promoter"]

    dbcur.execute(
        "SELECT notify_user(%s, %s, 'payout_created', 'Titulo', 'Cuerpo', '/promotor')",
        (user["id"], venue),
    )
    dbcur.execute(
        """
        SELECT n.id, o.processed_at, n.kind, n.link
        FROM notifications n
        JOIN push_outbox o ON o.notification_id = n.id
        WHERE n.user_id = %s AND n.kind = 'payout_created'
        ORDER BY n.id DESC LIMIT 1
        """,
        (user["id"],),
    )
    row = dbcur.fetchone()
    assert row is not None, "notify_user debe dejar carta en push_outbox"
    assert row["processed_at"] is None, "la carta nace pendiente de drenar"
    assert row["link"] == "/promotor"


def test_notify_venue_admins_one_letter_each(db, dbcur, world):
    """Cada admin de la venue recibe SU notificación y SU carta de push."""
    venue = world["venue_a"]

    admins_antes = dbcur.execute(
        """
        SELECT count(*) AS n FROM venue_user_roles
        WHERE venue_id = %s AND role IN ('admin', 'super_admin')
        """,
        (venue,),
    ).fetchone()["n"]

    dbcur.execute(
        "SELECT notify_venue_admins(%s, 'payout_disputed', 'Titulo', 'Cuerpo', '/admin')",
        (venue,),
    )
    cartas = dbcur.execute(
        """
        SELECT count(*) AS n
        FROM push_outbox o
        JOIN notifications n ON n.id = o.notification_id
        WHERE n.venue_id = %s AND n.kind = 'payout_disputed'
        """,
        (venue,),
    ).fetchone()["n"]

    assert cartas == admins_antes, "una carta por admin, ni más ni menos"


def test_drain_once_retries_after_push_service_failure(api, dbcur, monkeypatch):
    """Un fallo de red no puede marcar la carta como enviada.

    El worker solo confirma cuando el servicio push aceptó al menos un
    dispositivo. Si todos fallan por red, la carta queda pendiente para el
    próximo tick; los endpoints muertos (404/410) sí se descartan.
    """
    import asyncio
    import os

    import psycopg
    from psycopg.rows import dict_row

    import app.core.push_worker as worker

    venue = api.world["venue_a"]
    user = api.world["promoter"]
    endpoint = f"https://push.test/retry-{user['id']}@example.test"
    res = api.post(
        "/push/subscribe",
        "promoter",
        {
            "venue_id": venue,
            "endpoint": endpoint,
            "keys": {
                "p256dh": "p256dh-de-prueba-0123456789abcdef",
                "auth": "auth-de-prueba-0123456789abcdef",
            },
        },
    )
    assert res.status_code == 204, res.text

    title = f"Reintento {user['id']}"
    dbcur.execute(
        "SELECT notify_user(%s, %s, 'payout_created', %s, 'Cuerpo', '/promotor')",
        (user["id"], venue, title),
    )
    outbox_id = dbcur.execute(
        """SELECT o.id
           FROM push_outbox o
           JOIN notifications n ON n.id = o.notification_id
           WHERE n.user_id=%s AND n.title=%s
           ORDER BY o.id DESC LIMIT 1""",
        (user["id"], title),
    ).fetchone()["id"]

    class Failed:
        ok = False
        dead = False
        status_code = 503

    async def fake_fail(endpoint, p256dh, auth, **kwargs):
        return Failed()

    monkeypatch.setattr(worker, "send_web_push", fake_fail)

    async def drain():
        conn = await psycopg.AsyncConnection.connect(
            os.environ.get(
                "TEST_DATABASE_URL",
                "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
            ),
            autocommit=True,
            row_factory=dict_row,
        )
        try:
            for _ in range(200):
                if await worker._drain_once(conn) == 0:
                    break
        finally:
            await conn.close()

    asyncio.run(drain())
    row = dbcur.execute(
        "SELECT processed_at FROM push_outbox WHERE id=%s", (outbox_id,)
    ).fetchone()
    assert row["processed_at"] is None, "un fallo de red no debe confirmar el envío"

    class Ok:
        ok = True
        dead = False
        status_code = 201

    async def fake_ok(endpoint, p256dh, auth, **kwargs):
        return Ok()

    monkeypatch.setattr(worker, "send_web_push", fake_ok)
    asyncio.run(drain())
    row = dbcur.execute(
        "SELECT processed_at FROM push_outbox WHERE id=%s", (outbox_id,)
    ).fetchone()
    assert row["processed_at"] is not None


def test_drain_once_marks_letter_processed(db, dbcur, world):
    """El drenador marca procesada la carta del usuario SIN suscripciones:
    nadie a quien avisar = carta cumplida (no se reintenta eterno)."""
    import asyncio

    import psycopg
    from psycopg.rows import dict_row

    from app.core.push_worker import _drain_once

    venue = world["venue_a"]
    user = world["promoter"]
    dbcur.execute(
        "SELECT notify_user(%s, %s, 'payout_reviewed', 'Titulo', 'Cuerpo', NULL)",
        (user["id"], venue),
    )

    # _drain_once es async y exige conexion psycopg ASYNC: abrimos la nuestra
    # (misma DB de prueba) y corremos el drenador REAL, no una copia del SQL.
    def _dsn() -> str:
        import os

        return os.environ.get(
            "TEST_DATABASE_URL",
            "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
        )

    async def _drain():
        conn = await psycopg.AsyncConnection.connect(
            _dsn(), autocommit=True, row_factory=dict_row
        )
        total = 0
        try:
            # La suite comparte la DB y los triggers de asignación dejan cartas
            # pendientes. Drenamos tandas hasta vaciar la cola para que el
            # contrato se verifique sobre la carta de ESTE test.
            for _ in range(200):
                processed = await _drain_once(conn)
                if processed == 0:
                    break
                total += processed
        finally:
            await conn.close()
        return total

    processed = asyncio.run(_drain())
    assert processed >= 1

    row = dbcur.execute(
        """
        SELECT o.processed_at
        FROM push_outbox o
        JOIN notifications n ON n.id = o.notification_id
        WHERE n.user_id = %s AND n.kind = 'payout_reviewed'
        ORDER BY o.id DESC LIMIT 1
        """,
        (user["id"],),
    ).fetchone()
    assert row is not None and row["processed_at"] is not None
