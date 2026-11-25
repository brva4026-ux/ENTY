"""Perfil rediseñado: contacto, sesiones, export, correo y avisos reales.

Las pruebas usan la API real y la DB de prueba. Lo que se busca demostrar es
la regla de producto: guardar un dato no lo publica, el servidor manda sobre
la visibilidad, y un aviso de puerta llega a la persona y organización que
corresponden.
"""
import asyncio
import hashlib
import os
import uuid

import psycopg
from psycopg.rows import dict_row


def _login(api, identifier: str, password: str):
    return api.client.post(
        "/auth/login", json={"identifier": identifier, "password": password}
    )


def _sub(endpoint: str | None = None) -> dict:
    return {
        "endpoint": endpoint or f"https://push.test/{uuid.uuid4().hex}",
        "p256dh": "p256dh-de-prueba-0123456789abcdef",
        "auth": "auth-de-prueba-0123456789abcdef",
    }


def test_public_contact_requires_data_for_each_published_channel(api):
    venue = api.world["venue_a"]
    # Activar WhatsApp sin teléfono no puede quedar guardado: la ficha
    # pública prometería un canal que no existe.
    res = api.patch(
        f"/auth/venues/{venue}",
        "admin",
        {
            "contact_phone": "",
            "public_contact_enabled": True,
            "public_contact_channels": ["whatsapp"],
        },
    )
    assert res.status_code == 422, res.text

    res = api.patch(
        f"/auth/venues/{venue}",
        "admin",
        {
            "contact_email": "",
            "public_contact_enabled": True,
            "public_contact_channels": ["email"],
        },
    )
    assert res.status_code == 422, res.text

    # El PATCH parcial que activa un canal usa el dato YA guardado, sin
    # obligar al cliente a reenviarlo.
    res = api.patch(
        f"/auth/venues/{venue}",
        "admin",
        {
            "contact_phone": "573001112233",
            "contact_email": "reservas@local.test",
            "public_contact_enabled": False,
        },
    )
    assert res.status_code == 200, res.text
    res = api.patch(
        f"/auth/venues/{venue}",
        "admin",
        {"public_contact_enabled": True, "public_contact_channels": ["whatsapp"]},
    )
    assert res.status_code == 200, res.text


def test_team_contact_visibility_hides_door_ops_contact(api):
    venue = api.world["venue_a"]
    event = api.create_event("admin", venue, name="Contacto interno")
    api.publish("admin", venue, event["id"])

    res = api.patch(
        f"/auth/venues/{venue}",
        "admin",
        {
            "contact_name": "Reservas",
            "contact_phone": "573001112233",
            "contact_team_visible": False,
        },
    )
    assert res.status_code == 200, res.text

    ctx = api.get(f"/venues/{venue}/events/{event['id']}/door-context", "bouncer")
    assert ctx.status_code == 200, ctx.text
    assert ctx.json()["ops_contact_name"] is None
    assert ctx.json()["ops_contact_phone"] is None

    api.patch(
        f"/auth/venues/{venue}", "admin", {"contact_team_visible": True}
    )
    ctx = api.get(f"/venues/{venue}/events/{event['id']}/door-context", "bouncer")
    assert ctx.json()["ops_contact_name"] == "Reservas"
    assert ctx.json()["ops_contact_phone"] == "573001112233"


def test_logout_revokes_this_session(api):
    token = api.token("promoter")
    out = api.client.post(
        "/auth/logout",
        headers={
            "Authorization": f"Bearer {token}",
            "Origin": "http://testserver",
        },
    )
    assert out.status_code == 200, out.text

    me = api.client.get(
        "/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert me.status_code == 401


def test_export_includes_saved_preferences(api):
    venue = api.world["venue_a"]
    res = api.client.put(
        f"/auth/me/preferences/onboarding?venue_id={venue}",
        headers=api.headers("admin"),
        json={"value": "accepted", "step": 2},
    )
    assert res.status_code == 200, res.text

    export = api.post(
        "/auth/export", "admin", {"password": api.world["password"]}
    )
    assert export.status_code == 200, export.text
    body = export.json()
    pref = next(
        p
        for p in body["preferences"]
        if p["venue_id"] == venue and p["key"] == "onboarding"
    )
    assert pref["value"] == "accepted"
    assert pref["step"] == 2


def test_email_change_keeps_account_and_ticket_contact(api, db):
    venue = api.world["venue_a"]
    admin = api.world["admin"]
    old_email = admin["email"]
    new_email = f"nuevo-{uuid.uuid4().hex[:8]}@example.test"

    event = api.create_event("admin", venue, name="Boleta del correo")
    ttype = api.add_type("admin", venue, event["id"])
    api.publish("admin", venue, event["id"])
    ticket = api.emit(
        "admin",
        venue,
        event["id"],
        ticket_type_id=ttype["id"],
        allocation_id=None,
    )
    db.execute(
        "UPDATE tickets SET customer_email=%s WHERE id=%s",
        (old_email, ticket["ticket_id"]),
    )

    res = api.post(
        "/auth/change-email",
        "admin",
        {"new_email": new_email, "current_password": api.world["password"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["pending_email"] == new_email

    raw = "token-cambio-correo-" + uuid.uuid4().hex
    db.execute(
        """INSERT INTO email_change_tokens (user_id, new_email, token_hash, expires_at)
           VALUES (%s, %s, %s, now() + interval '1 hour')""",
        (admin["id"], new_email, hashlib.sha256(raw.encode()).hexdigest()),
    )

    confirmed = api.client.post("/auth/change-email/confirm", json={"token": raw})
    assert confirmed.status_code == 200, confirmed.text
    summary = confirmed.json()
    assert summary["id"] == admin["id"]
    assert summary["email"] == new_email
    assert summary["roles"][str(venue)] == ["admin"]

    assert _login(api, old_email, api.world["password"]).status_code == 401
    assert _login(api, new_email, api.world["password"]).status_code == 200

    # La boleta conserva el contacto con el que se compró: cambiar la llave de
    # la cuenta no reescribe datos de clientes ni rompe su enlace de acceso.
    row = db.execute(
        "SELECT customer_email FROM tickets WHERE id=%s", (ticket["ticket_id"],)
    ).fetchone()
    assert row["customer_email"] == old_email


def test_push_outbox_does_not_cross_organizations(api, db, monkeypatch):
    venue_a = api.world["venue_a"]
    venue_b = api.world["venue_b"]
    user_id = api.world["promoter"]["id"]
    title = f"Aviso de {uuid.uuid4().hex[:8]}"
    endpoint_a = f"https://push.test/a-{uuid.uuid4().hex}"
    endpoint_b = f"https://push.test/b-{uuid.uuid4().hex}"

    for endpoint, venue in ((endpoint_a, venue_a), (endpoint_b, venue_b)):
        sub = _sub(endpoint)
        db.execute(
            """INSERT INTO push_subscriptions
                   (user_id, venue_id, endpoint, p256dh, auth)
               VALUES (%s, %s, %s, %s, %s)""",
            (user_id, venue, sub["endpoint"], sub["p256dh"], sub["auth"]),
        )
    db.execute(
        "SELECT notify_user(%s, %s, 'payout_created', %s, %s, '/promotor')",
        (user_id, venue_a, title, "Cuerpo de prueba"),
    )

    sent: list[tuple[str, str]] = []

    class Result:
        ok = True
        dead = False
        status_code = 201

    async def fake_send(endpoint, p256dh, auth, **kwargs):
        sent.append((endpoint, kwargs["payload"]["title"]))
        return Result()

    import app.core.config as config_mod
    import app.core.push_worker as worker

    monkeypatch.setattr(worker, "send_web_push", fake_send)
    monkeypatch.setattr(
        config_mod.get_settings(), "vapid_private_key_b64", "test-key", raising=False
    )

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
    assert (endpoint_a, title) in sent
    assert (endpoint_b, title) not in sent


def test_door_open_push_and_bell_target_role_event(api, db, monkeypatch):
    venue = api.world["venue_a"]
    event = api.create_event("admin", venue, name="Aviso de puerta")
    api.publish("admin", venue, event["id"])
    for who, role in (("bouncer", "bouncer"), ("promoter", "promotor")):
        db.execute(
            """INSERT INTO event_staff (event_id, user_id, role, assigned_by)
               VALUES (%s, %s, %s, %s)""",
            (event["id"], api.world[who]["id"], role, api.world["admin"]["id"]),
        )

    endpoints = {
        "bouncer": _sub(),
        "promoter": _sub(),
        "admin": _sub(),
    }
    for who, sub in endpoints.items():
        res = api.post(
            "/push/subscribe",
            who,
            {
                "venue_id": venue,
                "endpoint": sub["endpoint"],
                "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
            },
        )
        assert res.status_code == 204, res.text

    captured: dict[str, dict] = {}

    async def fake_notify(rows, payload, **kwargs):
        for row in rows:
            captured[row["endpoint"]] = payload
        return ([], len(rows))

    import app.core.config as config_mod
    import app.routers.lifecycle as lifecycle_mod

    monkeypatch.setattr(lifecycle_mod, "notify_venue", fake_notify)
    monkeypatch.setattr(
        config_mod.get_settings(), "vapid_private_key_b64", "test-key", raising=False
    )

    res = api.post(f"/venues/{venue}/events/{event['id']}/live", "admin")
    assert res.status_code == 200, res.text

    assert captured[endpoints["bouncer"]["endpoint"]]["url"] == (
        f"/bouncer?evento={event['id']}"
    )
    assert captured[endpoints["promoter"]["endpoint"]]["url"] == (
        f"/promotor/evento/{event['id']}"
    )
    # El admin que abrió puertas no se auto-notifica.
    assert endpoints["admin"]["endpoint"] not in captured

    rows = db.execute(
        """SELECT user_id, link FROM notifications
           WHERE venue_id=%s AND kind='door_open'
           ORDER BY id DESC""",
        (venue,),
    ).fetchall()
    # La campana usa el mismo roster y el mismo destino por rol.
    by_user = {r["user_id"]: r["link"] for r in rows}
    assert by_user[api.world["bouncer"]["id"]] == f"/bouncer?evento={event['id']}"
    assert by_user[api.world["promoter"]["id"]] == (
        f"/promotor/evento/{event['id']}"
    )
    assert api.world["admin"]["id"] not in by_user
