"""Outbox de push (mig 014): escribir notificación = dejar push pendiente.

Los triggers de negocio llaman a notify_user/notify_venue_admins; desde la
014 esas funciones también insertan en push_outbox, en la MISMA transacción.
Aquí se verifica el contrato de las funciones SQL (no el worker, que necesita
VAPID y red): una llamada a notify_user produce notificación + carta
pendiente, y notify_venue_admins una carta por admin.
"""
import pytest


def test_notify_user_writes_outbox_letter(db, dbcur, world):
    venue = world["venue_a"]
    user = world["promoter"]

    dbcur.execute(
        "SELECT notify_user(%s, %s, 'test_kind', 'Titulo', 'Cuerpo', '/promotor')",
        (user["id"], venue),
    )
    dbcur.execute(
        """
        SELECT n.id, o.processed_at, n.kind, n.link
        FROM notifications n
        JOIN push_outbox o ON o.notification_id = n.id
        WHERE n.user_id = %s AND n.kind = 'test_kind'
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
        "SELECT notify_venue_admins(%s, 'test_admins', 'Titulo', 'Cuerpo', '/admin')",
        (venue,),
    )
    cartas = dbcur.execute(
        """
        SELECT count(*) AS n
        FROM push_outbox o
        JOIN notifications n ON n.id = o.notification_id
        WHERE n.venue_id = %s AND n.kind = 'test_admins'
        """,
        (venue,),
    ).fetchone()["n"]

    assert cartas == admins_antes, "una carta por admin, ni más ni menos"


def test_drain_once_marks_letter_processed(db, dbcur, world):
    """El drenador marca procesada la carta del usuario SIN suscripciones:
    nadie a quien avisar = carta cumplida (no se reintenta eterno)."""
    import asyncio

    from app.core.push_worker import _drain_once

    venue = world["venue_a"]
    user = world["promoter"]
    dbcur.execute(
        "SELECT notify_user(%s, %s, 'test_drain', 'Titulo', 'Cuerpo', NULL)",
        (user["id"], venue),
    )

    processed = asyncio.run(_drain_once(db))
    assert processed >= 1

    row = dbcur.execute(
        """
        SELECT o.processed_at
        FROM push_outbox o
        JOIN notifications n ON n.id = o.notification_id
        WHERE n.user_id = %s AND n.kind = 'test_drain'
        ORDER BY o.id DESC LIMIT 1
        """,
        (user["id"],),
    ).fetchone()
    assert row is not None and row["processed_at"] is not None
