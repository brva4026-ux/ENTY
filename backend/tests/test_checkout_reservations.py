"""Reservas reales: nunca cobrar dos veces por el ultimo cupo/descuento."""
import uuid
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest

from tests.test_public_checkout import _scenario, _checkout, _signed_webhook, wompi_on


def test_pending_checkout_reserves_last_ticket(api, wompi_on):
    _, event, kind = _scenario(api, quantity=1)
    assert _checkout(api, event, kind["id"]).status_code == 201
    second = _checkout(api, event, kind["id"])
    assert second.status_code == 409, second.text


def test_pending_checkout_blocks_direct_sale(api, wompi_on):
    venue, event, kind = _scenario(api, quantity=1)
    assert _checkout(api, event, kind["id"]).status_code == 201
    sale = api.post(f"/venues/{venue}/events/{event}/tickets", "admin", {
        "ticket_type_id": kind["id"], "customer_name": "Taquilla", "customer_phone": "573001112233",
    })
    assert sale.status_code == 409, sale.text


def test_coupon_last_use_is_reserved_before_payment(api, wompi_on):
    venue, event, kind = _scenario(api)
    api.post(f"/venues/{venue}/events/{event}/coupons", "admin", {
        "code": "ULTIMO", "kind": "percent", "value": 20, "max_uses": 1,
    })
    first = _checkout(api, event, kind["id"], extra={"coupon_code": "ULTIMO"})
    assert first.status_code == 201, first.text
    second = _checkout(api, event, kind["id"], extra={"coupon_code": "ULTIMO"})
    # Un cupon reservado no puede volver a descontar: el contrato existente
    # para un codigo agotado permite cobrar el precio normal.
    assert second.status_code in (201, 409), second.text
    if second.status_code == 201:
        assert second.json()["amount_in_cents"] == 5000000


def test_expired_reservation_releases_inventory(api, wompi_on):
    _, event, kind = _scenario(api, quantity=1)
    first = _checkout(api, event, kind["id"])
    assert first.status_code == 201
    ref = first.json()["reference"]
    api.run_sql(f"UPDATE ticket_payments SET reservation_expires_at=now()-interval '1 second' WHERE reference='{ref}'")
    assert _checkout(api, event, kind["id"]).status_code == 201


def test_late_paid_checkout_is_visible_for_reconciliation(api, wompi_on):
    from tests.test_public_checkout import _LINK
    _, event, kind = _scenario(api, quantity=1)
    first = _checkout(api, event, kind["id"])
    ref, link = first.json()["reference"], _LINK["id"]
    api.run_sql(f"UPDATE ticket_payments SET reservation_expires_at=now()-interval '1 second' WHERE reference='{ref}'")
    assert _checkout(api, event, kind["id"]).status_code == 201
    payload = _signed_webhook(wompi_on.wompi_events_secret, amount=5000000, link_id=link)
    response = api.client.post("/payments/wompi/webhook", json=payload)
    assert response.status_code == 200, response.text
    status = api.client.get(f"/public/checkout/{ref}").json()
    assert status["status"] == "paid_unfulfilled"
    assert status["approved"] is False and status["ticket_id"] is None
    # El reintento no vuelve a notificar ni emite una entrada extra.
    assert api.client.post("/payments/wompi/webhook", json=payload).status_code == 200
    assert api.run_sql(f"SELECT count(*) FROM tickets WHERE event_id={event}") == 0


def test_failed_provider_releases_reservation(api, wompi_on, monkeypatch):
    from app.services import wompi
    _, event, kind = _scenario(api, quantity=1)
    original = wompi.create_payment_link
    async def fail(**kwargs):
        raise wompi.WompiError("provider unavailable")
    monkeypatch.setattr(wompi, "create_payment_link", fail)
    assert _checkout(api, event, kind["id"]).status_code == 502
    monkeypatch.setattr(wompi, "create_payment_link", original)
    assert _checkout(api, event, kind["id"]).status_code == 201


def test_concurrent_reservations_cannot_take_same_slot(api, wompi_on):
    _, event, kind = _scenario(api, quantity=1)
    def reserve(_):
        with psycopg.connect(api.dsn, autocommit=True) as conn:
            try:
                conn.execute("SELECT reserve_ticket_payment(%s,%s,%s,%s,%s,%s,NULL,NULL,NULL,0,now()+interval '15 minutes')", (
                    event, kind["id"], uuid.uuid4().hex, 5000000, "Fan", "573001112233",
                ))
                return "reserved"
            except psycopg.errors.RaiseException as error:
                return error.diag.message_primary
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, range(2)))
    assert sorted(results) == ["reserved", "ticket_type_sold_out"]
