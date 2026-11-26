"""Sesiones múltiples y pases que emiten una boleta por jornada."""
import uuid
from datetime import datetime, timedelta, timezone

from tests.test_public_checkout import (  # noqa: F401
    _LINK,
    _checkout,
    _signed_webhook,
    wompi_on,
)


def _event(api, *, capacity=100):
    venue = api.world["venue_a"]
    ev = api.create_event(
        "admin", venue, name=f"Festival {uuid.uuid4().hex[:6]}", capacity=capacity
    )
    api.publish("admin", venue, ev["id"])
    return venue, ev["id"]


def _session(api, venue, event, *, hours, name, capacity=10):
    starts = datetime.now(timezone.utc) + timedelta(hours=hours)
    res = api.post(
        f"/venues/{venue}/events/{event}/sessions",
        "admin",
        {
            "name": name,
            "starts_at": starts.isoformat(),
            "ends_at": (starts + timedelta(hours=6)).isoformat(),
            "capacity": capacity,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def _pass(api, venue, event, sessions, *, quantity=5):
    res = api.post(
        f"/venues/{venue}/events/{event}/passes",
        "admin",
        {
            "name": "Pase 2 días",
            "price_cents": 5000000,
            "quantity": quantity,
            "session_ids": [s["id"] for s in sessions],
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_pass_emits_one_ticket_per_session(api, wompi_on):  # noqa: F811
    venue, event = _event(api)
    day1 = _session(api, venue, event, hours=30, name="Día 1")
    day2 = _session(api, venue, event, hours=54, name="Día 2")
    pass_type = _pass(api, venue, event, [day1, day2])
    assert len(pass_type["sessions"]) == 2
    assert pass_type["sessions"][0]["session_ticket_type_id"] > 0

    checkout = _checkout(api, event, pass_type["id"])
    assert checkout.status_code == 201, checkout.text
    ref = checkout.json()["reference"]
    assert checkout.json()["amount_in_cents"] == 5000000

    payload = _signed_webhook(
        wompi_on.wompi_events_secret, amount=5000000, link_id=_LINK["id"]
    )
    approved = api.client.post("/payments/wompi/webhook", json=payload)
    assert approved.status_code == 200, approved.text

    status = api.client.get(f"/public/checkout/{ref}").json()
    assert status["status"] == "approved"
    assert status["ticket_id"]

    # Una boleta del pase en el evento padre y una por jornada.
    assert api.run_sql(f"SELECT count(*) FROM tickets WHERE event_id={event}") == 1
    for session in (day1, day2):
        assert api.run_sql(
            f"SELECT count(*) FROM tickets WHERE event_id={session['id']}"
        ) == 1
    assert api.run_sql(
        f"SELECT count(*) FROM ticket_payment_tickets WHERE payment_id="
        f"(SELECT id FROM ticket_payments WHERE reference='{ref}')"
    ) == 2
    # El dinero queda una sola vez: en la boleta del pase.
    assert api.run_sql(
        f"SELECT sum(price_cents_snapshot) FROM tickets WHERE event_id={event}"
    ) == 5000000
    for session in (day1, day2):
        assert api.run_sql(
            f"SELECT sum(price_cents_snapshot) FROM tickets WHERE event_id={session['id']}"
        ) == 0

    # El reintento del webhook no duplica jornadas.
    assert api.client.post("/payments/wompi/webhook", json=payload).status_code == 200
    assert api.run_sql(
        f"SELECT count(*) FROM tickets WHERE event_id IN ({event},{day1['id']},{day2['id']})"
    ) == 3


def test_pass_rejects_session_from_another_event(api):
    venue, event = _event(api)
    _, other = _event(api)
    foreign = _session(api, venue, other, hours=30, name="Otra")
    res = api.post(
        f"/venues/{venue}/events/{event}/passes",
        "admin",
        {
            "name": "Pase inválido",
            "price_cents": 1000,
            "quantity": 1,
            "session_ids": [foreign["id"]],
        },
    )
    assert res.status_code == 422, res.text
