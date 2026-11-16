"""Retención (mig 046): las tablas que crecen se podan.

Cinco tablas acumulaban filas para siempre. `prune_expired()` las limpia y se
dispara de forma perezosa desde rutas que ya se visitan (mismo patrón que el
auto-cierre y el rate limit: no hay cron en serverless).

Los tests fijan dos contratos:
  1. Qué se borra y qué NO: una notificación no leída es trabajo pendiente del
     usuario y no se toca; un push pendiente (processed_at NULL) es trabajo del
     worker; lo viejo y ya consumido sí se va.
  2. El throttle en proceso: `prune_expired_rows` no golpea la DB en cada
     lectura (una vez por ventana por instancia).
"""
import time
import uuid

from app.core import lifecycle


def _old() -> str:
    return "now() - interval '400 days'"


def _insert_analytics(dbcur, session: str, when: str) -> None:
    dbcur.execute(
        "INSERT INTO analytics_events (name, session_id, created_at) "
        f"VALUES ('view_home', %s, {when})",
        (session,),
    )


def test_prune_expired_borra_lo_viejo_y_respeta_lo_pendiente(dbcur, world):
    """`prune_expired()` borra sólo lo viejo y ya consumido."""
    venue = world["venue_a"]
    user = world["admin"]["id"]
    old = _old()

    # analytics_events: vieja se va, nueva se queda.
    _insert_analytics(dbcur, f"session-{uuid.uuid4().hex[:10]}", old)
    _insert_analytics(dbcur, f"session-{uuid.uuid4().hex[:10]}", "now()")
    # notifications: leída y vieja se va; no leída (aunque vieja) se queda.
    dbcur.execute(
        "INSERT INTO notifications (user_id, venue_id, kind, title, body, read_at, created_at) "
        f"VALUES (%s, %s, 'event_reminder', 'Vieja leída', 'x', {old}, {old}), "
        f"(%s, %s, 'event_reminder', 'Vieja sin leer', 'x', NULL, {old})",
        (user, venue, user, venue),
    )
    # audit_log: vieja se va.
    dbcur.execute(
        "INSERT INTO audit_log (venue_id, kind, entity, created_at) "
        f"VALUES (%s, 'test', 'event', {old})",
        (venue,),
    )

    before_analytics = dbcur.execute(
        "SELECT count(*) AS n FROM analytics_events WHERE created_at < now() - interval '180 days'"
    ).fetchone()["n"]
    assert before_analytics >= 1

    dbcur.execute("SELECT prune_expired()")

    assert (
        dbcur.execute(
            "SELECT count(*) AS n FROM analytics_events "
            "WHERE created_at < now() - interval '180 days'"
        ).fetchone()["n"]
        == 0
    )
    assert (
        dbcur.execute(
            "SELECT count(*) AS n FROM audit_log "
            "WHERE created_at < now() - interval '365 days'"
        ).fetchone()["n"]
        == 0
    )
    # La no leída sigue ahí: borrarla sería perder el aviso.
    assert (
        dbcur.execute(
            "SELECT count(*) AS n FROM notifications "
            "WHERE title = 'Vieja sin leer'"
        ).fetchone()["n"]
        == 1
    )


def test_push_outbox_solo_poda_lo_procesado(dbcur, world):
    """Un push pendiente (processed_at NULL) es trabajo del worker: no se toca."""
    venue = world["venue_a"]
    user = world["admin"]["id"]
    old = _old()
    nid = dbcur.execute(
        "INSERT INTO notifications (user_id, venue_id, kind, title, body) "
        "VALUES (%s, %s, 'event_reminder', 'Push', 'x') RETURNING id",
        (user, venue),
    ).fetchone()["id"]
    dbcur.execute(
        "INSERT INTO push_outbox (notification_id, processed_at, created_at) "
        f"VALUES (%s, {old}, {old}), (%s, NULL, {old})",
        (nid, nid),
    )
    dbcur.execute("SELECT prune_push_outbox(7)")
    rows = dbcur.execute(
        "SELECT processed_at FROM push_outbox WHERE notification_id = %s", (nid,)
    ).fetchall()
    assert len(rows) == 1, "sólo la procesada debía borrarse"
    assert rows[0]["processed_at"] is None


def test_prune_expired_rows_tiene_throttle(monkeypatch):
    """La poda perezosa no golpea la DB en cada lectura: una vez por ventana."""
    import asyncio

    calls = {"n": 0}

    class _Conn:
        def cursor(self):
            calls["n"] += 1
            raise AssertionError("dentro de la ventana no debe abrir cursor")

    # Estado "recién podado": la llamada debe retornar sin tocar la DB.
    monkeypatch.setattr(lifecycle, "_last_prune", time.monotonic())
    asyncio.run(lifecycle.prune_expired_rows(_Conn(), context="test"))
    assert calls["n"] == 0

    # Fuera de la ventana sí ejecuta el SELECT (abre el cursor). El valor debe
    # ser relativo a `time.monotonic()`: en un contenedor recién arrancado el
    # reloj puede ir por debajo de la ventana, y `0.0` quedaría "dentro".
    monkeypatch.setattr(
        lifecycle, "_last_prune", time.monotonic() - lifecycle._PRUNE_EVERY_SECONDS - 1
    )

    class _Cursor:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def execute(self, *a):
            calls["n"] += 1

    class _Conn2:
        def cursor(self):
            return _Cursor()

    asyncio.run(lifecycle.prune_expired_rows(_Conn2(), context="test"))
    assert calls["n"] == 1
