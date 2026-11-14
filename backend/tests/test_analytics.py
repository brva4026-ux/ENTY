"""Embudo de producto: ingesta anonima y lectura por venue.

Lo que importa que NO pase: que la ingesta publique acepte cualquier nombre,
que rompa el lote entero por un `event_id` viejo, o que un admin de una venue
vea el trafico y el dinero de otra.
"""
import uuid


def _tag() -> str:
    return uuid.uuid4().hex[:8]


def _ingest(client, session_id: str, events: list[dict]):
    return client.post(
        "/public/analytics/events",
        json={"session_id": session_id, "events": events},
    )


def test_ingest_stores_events_without_any_identity(api_client, db):
    tag = _tag()
    session_id = f"session-{tag}"

    res = _ingest(
        api_client,
        session_id,
        [
            {"name": "view_home", "path": "/inicio"},
            {"name": "view_event", "path": "/evento/1", "event_id": 1},
        ],
    )
    assert res.status_code == 204, res.text

    rows = db.execute(
        "SELECT name, path, event_id FROM analytics_events WHERE session_id = %s ORDER BY id",
        (session_id,),
    ).fetchall()
    assert [r["name"] for r in rows] == ["view_home", "view_event"]
    assert rows[0]["path"] == "/inicio"
    # El id 1 puede no existir en la DB de prueba: se descarta, no se inventa.
    assert rows[1]["event_id"] in (None, 1)

    # Nada que identifique a la persona quedo guardado.
    cols = db.execute(
        "SELECT * FROM analytics_events WHERE session_id = %s LIMIT 1", (session_id,)
    ).fetchone()
    for forbidden in ("ip", "user_id", "email", "phone", "user_agent"):
        assert forbidden not in cols


def test_ingest_drops_unknown_names_and_keeps_the_rest(api_client, db):
    session_id = f"session-{_tag()}"
    res = _ingest(
        api_client,
        session_id,
        [
            {"name": "inventado", "path": "/x"},
            {"name": "view_home", "path": "/inicio"},
        ],
    )
    assert res.status_code == 204, res.text
    rows = db.execute(
        "SELECT name FROM analytics_events WHERE session_id = %s", (session_id,)
    ).fetchall()
    assert [r["name"] for r in rows] == ["view_home"]


def test_ingest_rejects_oversized_batches_and_short_sessions(api_client):
    too_many = [{"name": "view_home"}] * 21
    assert _ingest(api_client, "session-ok-123", too_many).status_code == 422
    assert _ingest(api_client, "abc", [{"name": "view_home"}]).status_code == 422


def test_funnel_counts_sessions_and_money_per_venue(api, api_client, db):
    venue = api.world["venue_a"]
    other_venue = api.world["venue_b"]
    event = api.create_event("admin", venue, name=f"Embudo {_tag()}", capacity=50)
    api.add_type(
        "admin", venue, event["id"],
        name="General", price_cents=4500000, quantity=20, is_courtesy=False,
    )
    api.publish("admin", venue, event["id"])

    tag = _tag()
    # Una sesion completa (vitrina -> evento -> checkout) y otra que solo mira.
    _ingest(
        api_client,
        f"full-{tag}",
        [
            {"name": "view_home", "path": "/inicio"},
            {"name": "view_event", "path": f"/evento/{event['id']}", "event_id": event["id"]},
            {"name": "checkout_start", "path": f"/evento/{event['id']}", "event_id": event["id"]},
        ],
    )
    _ingest(api_client, f"lurker-{tag}", [{"name": "view_home", "path": "/inicio"}])

    # Pago aprobado real de esta venue (el embudo NO lo toma de la ingesta).
    reference = f"TF-TEST-{tag}"
    db.execute(
        """
        INSERT INTO ticket_payments (venue_id, event_id, ticket_type_id, reference,
                                     amount_in_cents, customer_name, customer_phone,
                                     status, approved_at)
        VALUES (%s, %s,
                (SELECT id FROM ticket_types WHERE event_id = %s ORDER BY id LIMIT 1),
                %s, 4500000, 'Fan', '3000000000', 'approved', now())
        """,
        (venue, event["id"], event["id"], reference),
    )

    res = api.get(f"/venues/{venue}/funnel?days=7", "admin")
    assert res.status_code == 200, res.text
    body = res.json()
    steps = {s["key"]: s["count"] for s in body["steps"]}

    assert steps["view_event"] >= 1
    assert steps["checkout_start"] >= 1
    # El pago cuenta aunque nadie lo haya "trackeado": sale de ticket_payments.
    assert body["revenue_cents"] >= 4500000
    assert steps["paid"] >= 1

    # Un admin de otra venue no puede leer este embudo.
    denied = api.get(f"/venues/{venue}/funnel", "outsider")
    assert denied.status_code == 403, denied.text

    # Ni un visitante sin sesion.
    api_client.cookies.clear()
    assert api_client.get(f"/venues/{venue}/funnel").status_code == 401
