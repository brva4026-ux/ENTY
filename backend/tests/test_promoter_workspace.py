"""Espacio de promotor: acceso, origen, idempotencia, link y comisiones."""
import hashlib
import uuid
from datetime import date

import pytest

from app.routers import public as public_mod


def _assign(api, venue, event_id, who="promoter", role="promotor"):
    res = api.post(
        f"/venues/{venue}/events/{event_id}/staff",
        "admin",
        {"user_id": api.world[who]["id"], "role": role},
    )
    assert res.status_code == 201, res.text
    return res.json()


def _paid_scenario(api, *, price=100_000, quantity=20):
    venue = api.world["venue_a"]
    event = api.create_event("admin", venue, capacity=100)
    ttype = api.add_type(
        "admin", venue, event["id"], name="General",
        price_cents=price, quantity=quantity, is_courtesy=False,
    )
    api.publish("admin", venue, event["id"])
    _assign(api, venue, event["id"])
    return venue, event["id"], ttype["id"]


def test_promoter_events_only_own_and_include_removed_assignment(api):
    scen = api.scenario(alloc_capacity=3)
    venue, event_id, type_id = scen["venue"], scen["event"], scen["type"]
    _assign(api, venue, event_id)
    ticket = api.emit(
        "promoter", venue, event_id,
        ticket_type_id=type_id, allocation_id=scen["allocation"]["id"],
    )

    # La asignación se retira: el evento sigue visible por historial, pero ya
    # no se puede vender y el motivo es explícito.
    api.delete(f"/venues/{venue}/events/{event_id}/staff/{api.world['promoter']['id']}", "admin")
    res = api.get(f"/venues/{venue}/promoter/events", "promoter")
    assert res.status_code == 200, res.text
    [event] = [e for e in res.json() if e["id"] == event_id]
    assert event["assignment_active"] is False
    assert event["can_sell"] is False
    assert event["sell_reason"] == "assignment_removed"

    # La venta sigue en su historial y en el detalle.
    sales = api.get(f"/venues/{venue}/promoter/sales", "promoter").json()
    assert any(s["ticket_id"] == ticket["ticket_id"] for s in sales["items"])


def test_promoter_cannot_read_another_promoters_sale(api):
    scen = api.scenario(alloc_capacity=3)
    ticket = api.emit(
        "promoter", scen["venue"], scen["event"],
        ticket_type_id=scen["type"], allocation_id=scen["allocation"]["id"],
    )
    res = api.get(
        f"/venues/{scen['venue']}/promoter/sales/{ticket['ticket_id']}",
        "promoter2",
    )
    assert res.status_code == 404, res.text


def test_emission_is_idempotent_and_does_not_spend_quota_twice(api):
    scen = api.scenario(alloc_capacity=1)
    payload = {
        "ticket_type_id": scen["type"],
        "allocation_id": scen["allocation"]["id"],
        "customer_name": "Doble Toque",
        "customer_phone": "3001234567",
        "client_request_id": "req-" + uuid.uuid4().hex,
    }
    first = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets",
        "promoter", payload,
    )
    assert first.status_code == 201, first.text
    second = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets",
        "promoter", payload,
    )
    assert second.status_code == 201, second.text
    assert second.json()["ticket_id"] == first.json()["ticket_id"]
    assert second.json()["duplicate"] is True
    assert second.json()["raw_token"] is None

    [alloc] = [
        a for a in api.allocations("promoter", scen["venue"], scen["event"])
        if a["id"] == scen["allocation"]["id"]
    ]
    assert alloc["issued"] == 1

    # El endpoint de recuperación devuelve el mismo resultado sin token.
    recovered = api.get(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets/by-request/"
        f"{payload['client_request_id']}",
        "promoter",
    )
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["ticket_id"] == first.json()["ticket_id"]


def test_paid_direct_sale_has_origin_and_is_attributed(api):
    venue, event_id, type_id = _paid_scenario(api)
    res = api.post(
        f"/venues/{venue}/events/{event_id}/tickets",
        "promoter",
        {
            "ticket_type_id": type_id,
            "customer_name": "Venta Directa",
            "customer_phone": "3001234567",
            "payment_method": "efectivo",
        },
    )
    assert res.status_code == 201, res.text
    ticket_id = res.json()["ticket_id"]
    detail = api.get(f"/venues/{venue}/promoter/sales/{ticket_id}", "promoter")
    assert detail.status_code == 200, detail.text
    assert detail.json()["sale_channel"] == "promoter_direct"
    assert detail.json()["price_cents"] == 100_000


def test_quota_sale_is_marked_as_promoter_quota(api):
    scen = api.scenario(alloc_capacity=2)
    ticket = api.emit(
        "promoter", scen["venue"], scen["event"],
        ticket_type_id=scen["type"], allocation_id=scen["allocation"]["id"],
    )
    detail = api.get(
        f"/venues/{scen['venue']}/promoter/sales/{ticket['ticket_id']}",
        "promoter",
    )
    assert detail.status_code == 200, detail.text
    assert detail.json()["sale_channel"] == "promoter_quota"


def test_promoter_link_is_public_and_does_not_leak_promoter(api):
    venue, event_id, _ = _paid_scenario(api)
    res = api.get(f"/venues/{venue}/promoter/events/{event_id}/link", "promoter")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["url"].endswith(f"/evento/{event_id}?ref={body['public_id']}")
    assert str(api.world["promoter"]["id"]) not in body["url"]

    # La apertura se registra sin sesión.
    visit = api.client.post(f"/public/promoter-links/{body['public_id']}/visit")
    assert visit.status_code == 204, visit.text
    again = api.get(f"/venues/{venue}/promoter/events/{event_id}/link", "promoter")
    assert again.json()["visits"] == 1


@pytest.fixture()
def wompi_on(monkeypatch):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "wompi_private_key", "prv_test_x", raising=False)
    monkeypatch.setattr(settings, "wompi_events_secret", "test_events_y", raising=False)
    links = []

    async def fake_create_payment_link(**kwargs):
        link_id = f"link-promo-{uuid.uuid4().hex[:12]}"
        links.append(link_id)
        return {"id": link_id, "slug": link_id}

    monkeypatch.setattr(public_mod.wompi, "create_payment_link", fake_create_payment_link)
    return links, settings


def _signed_webhook(secret, *, amount, link_id):
    payload = {
        "event": "transaction.updated",
        "data": {
            "transaction": {
                "id": f"tx-{uuid.uuid4().hex}",
                "status": "APPROVED",
                "amount_in_cents": amount,
                "payment_link_id": link_id,
            }
        },
        "timestamp": 1727000000,
        "signature": {
            "properties": [
                "transaction.id",
                "transaction.status",
                "transaction.amount_in_cents",
            ],
            "checksum": "",
        },
    }
    pieces = []
    for prop in payload["signature"]["properties"]:
        value = payload["data"]
        for part in prop.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        pieces.append("" if value is None else str(value))
    pieces.append(str(payload["timestamp"]))
    pieces.append(secret)
    payload["signature"]["checksum"] = hashlib.sha256(
        "".join(pieces).encode("utf-8")
    ).hexdigest()
    return payload


def test_public_checkout_keeps_attribution_through_webhook(api, wompi_on):
    links, settings = wompi_on
    venue, event_id, type_id = _paid_scenario(api, price=50_000)
    link = api.get(f"/venues/{venue}/promoter/events/{event_id}/link", "promoter").json()

    checkout = api.client.post(
        f"/public/events/{event_id}/checkout",
        json={
            "ticket_type_id": type_id,
            "customer_name": "Fan Atribuido",
            "customer_phone": "573001112233",
            "customer_email": "fan@example.test",
            "promoter_ref": link["public_id"],
        },
    )
    assert checkout.status_code == 201, checkout.text
    payment = checkout.json()
    assert links, "no se creó el link de Wompi"

    webhook = _signed_webhook(
        settings.wompi_events_secret,
        amount=payment["amount_in_cents"],
        link_id=links[-1],
    )
    ok = api.client.post("/payments/wompi/webhook", json=webhook)
    assert ok.status_code == 200, ok.text

    # Reintento del proveedor: no duplica ni la boleta ni la métrica.
    again = api.client.post("/payments/wompi/webhook", json=webhook)
    assert again.status_code == 200, again.text

    sales = api.get(f"/venues/{venue}/promoter/sales", "promoter").json()
    [sale] = [s for s in sales["items"] if s["customer_name"] == "Fan Atribuido"]
    assert sale["sale_channel"] == "promoter_link"
    assert sale["payment_state"] == "confirmed"
    assert sale["price_cents"] == 50_000

    metrics = api.get(f"/venues/{venue}/promoter/events/{event_id}/link", "promoter").json()
    assert metrics["purchases"] == 1
    assert metrics["checkouts"] == 1
    assert metrics["attributed_revenue_cents"] == 50_000


def test_commission_summary_and_detail_match_payout(api):
    venue, event_id, type_id = _paid_scenario(api, price=100_000)
    api.run_sql(f"UPDATE venues SET commission_pct = 10 WHERE id = {venue}")
    emitted = api.post(
        f"/venues/{venue}/events/{event_id}/tickets",
        "promoter",
        {
            "ticket_type_id": type_id,
            "customer_name": "Base Comisión",
            "customer_phone": "3001234567",
        },
    )
    assert emitted.status_code == 201, emitted.text

    today = date.today().isoformat()
    generated = api.post(
        f"/venues/{venue}/payouts/generate",
        "admin",
        {
            "promoter_id": api.world["promoter"]["id"],
            "period_start": today,
            "period_end": today,
        },
    )
    assert generated.status_code == 201, generated.text
    payout = generated.json()
    assert payout["revenue_cents"] == 100_000
    assert payout["commission_cents"] == 10_000

    summary = api.get(f"/venues/{venue}/promoter/commissions", "promoter")
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["generated_cents"] == 10_000
    assert body["pending_settlement_cents"] == 10_000
    assert body["paid_cents"] == 0

    detail = api.get(
        f"/venues/{venue}/promoter/commissions/{payout['id']}", "promoter"
    )
    assert detail.status_code == 200, detail.text
    detail_body = detail.json()
    assert detail_body["base_cents"] == 100_000
    assert len(detail_body["items"]) == 1
    assert detail_body["items"][0]["sale_channel"] == "promoter_direct"

    paid = api.post(
        f"/venues/{venue}/payouts/{payout['id']}/review",
        "admin",
        {"action": "pay", "paid_cents": 10_000, "note": "pagado"},
    )
    assert paid.status_code == 200, paid.text
    summary2 = api.get(f"/venues/{venue}/promoter/commissions", "promoter").json()
    assert summary2["paid_cents"] == 10_000
    assert summary2["pending_settlement_cents"] == 0


def test_commissions_ignore_courtesies_and_rejected_payouts(api):
    # Una cortesía no genera base de comisión ni cuenta como venta pagada.
    scen = api.scenario(alloc_capacity=2)
    api.emit(
        "promoter", scen["venue"], scen["event"],
        ticket_type_id=scen["type"], allocation_id=scen["allocation"]["id"],
    )
    venue, event_id, type_id = _paid_scenario(api, price=100_000)
    api.run_sql(f"UPDATE venues SET commission_pct = 10 WHERE id = {venue}")
    emitted = api.post(
        f"/venues/{venue}/events/{event_id}/tickets",
        "promoter",
        {
            "ticket_type_id": type_id,
            "customer_name": "Venta Pagada",
            "customer_phone": "3001234567",
        },
    )
    assert emitted.status_code == 201, emitted.text

    summary = api.get(f"/venues/{venue}/promoter/commissions", "promoter").json()
    assert summary["eligible_sales_count"] == 1
    assert summary["attributed_revenue_cents"] == 100_000

    today = date.today().isoformat()
    generated = api.post(
        f"/venues/{venue}/payouts/generate",
        "admin",
        {
            "promoter_id": api.world["promoter"]["id"],
            "period_start": today,
            "period_end": today,
        },
    )
    assert generated.status_code == 201, generated.text
    payout = generated.json()
    assert payout["tickets_count"] == 2
    assert payout["revenue_cents"] == 100_000

    rejected = api.post(
        f"/venues/{venue}/payouts/{payout['id']}/review",
        "admin",
        {"action": "reject", "note": "Tarifa equivocada"},
    )
    assert rejected.status_code == 200, rejected.text
    after = api.get(f"/venues/{venue}/promoter/commissions", "promoter").json()
    assert after["generated_cents"] == 0
    assert after["pending_settlement_cents"] == 0


def test_promoter_notifications_cover_assignment_quota_and_close(api):
    venue = api.world["venue_a"]
    event = api.create_event("admin", venue, capacity=50)
    ttype = api.add_type("admin", venue, event["id"], quantity=10)
    api.publish("admin", venue, event["id"])
    _assign(api, venue, event["id"])

    api.set_allocation(
        "admin", venue, event["id"],
        ticket_type_id=ttype["id"],
        promoter_id=api.world["promoter"]["id"],
        capacity=4,
    )
    api.run_sql(f"UPDATE events SET status='live' WHERE id={event['id']}")
    api.run_sql(f"UPDATE events SET status='ended' WHERE id={event['id']}")

    feed = api.get("/notifications", "promoter").json()
    kinds = {n["kind"] for n in feed}
    assert {"event_assigned", "allocation_changed", "sales_closed"} <= kinds
    links = {n["link"] for n in feed if n["kind"] in {"event_assigned", "sales_closed"}}
    assert all(f"event={event['id']}" in link for link in links)
