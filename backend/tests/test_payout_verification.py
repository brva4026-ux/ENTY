"""Verificación de cobros y comisión de Enty (mig 074)."""
import uuid

import pytest

from app.core.config import get_settings
from app.routers import public as public_mod


@pytest.fixture()
def wompi_on(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "wompi_private_key", "prv_test_x", raising=False)
    monkeypatch.setattr(settings, "wompi_events_secret", "evt_test_y", raising=False)

    async def fake_create_payment_link(**kwargs):
        return {"id": f"link-{uuid.uuid4().hex[:10]}", "slug": "stub"}

    monkeypatch.setattr(
        public_mod.wompi, "create_payment_link", fake_create_payment_link
    )


def _paid_event(api, *, price=100_000):
    venue = api.world["venue_a"]
    event = api.create_event("admin", venue, name=f"Cobros {uuid.uuid4().hex[:6]}")
    tipo = api.add_type(
        "admin", venue, event["id"], name="General",
        price_cents=price, quantity=20, is_courtesy=False,
    )
    api.publish("admin", venue, event["id"])
    return venue, event["id"], tipo["id"]


def _profile(venue, **extra):
    data = {
        "legal_name": "Bar La Clave SAS",
        "tax_id": "900123456-7",
        "contact_name": "Ana Pérez",
        "contact_phone": "+57 300 123 4567",
        "contact_email": "ana@bar.test",
        "bank_name": "Bancolombia",
        "bank_account_type": "ahorros",
        "bank_account_last4": "4567",
    }
    data.update(extra)
    return data


def _put(api, venue, payload):
    return api.client.put(
        f"/venues/{venue}/payout-profile",
        headers=api.headers("admin"),
        json=payload,
    )


def test_payout_profile_blocks_online_sales_until_approved(api, db, wompi_on):
    venue, event, tipo = _paid_event(api)
    db.execute("DELETE FROM venue_payout_profiles WHERE venue_id=%s", (venue,))

    current = api.get(f"/venues/{venue}/payout-profile", "admin")
    assert current.status_code == 200, current.text
    assert current.json()["status"] == "not_started"
    assert current.json()["can_sell_online"] is False

    incomplete = _put(api, venue, {"legal_name": "Bar La Clave SAS"})
    assert incomplete.status_code == 200, incomplete.text
    assert incomplete.json()["missing_items"]

    submit = api.post(f"/venues/{venue}/payout-profile/submit", "admin")
    assert submit.status_code == 422, submit.text

    complete = _put(api, venue, _profile(venue))
    assert complete.status_code == 200, complete.text
    assert complete.json()["missing_items"] == []

    submit = api.post(f"/venues/{venue}/payout-profile/submit", "admin")
    assert submit.status_code == 200, submit.text
    assert submit.json()["status"] == "pending"

    blocked = api.client.post(
        f"/public/events/{event}/checkout",
        json={
            "ticket_type_id": tipo,
            "customer_name": "Fan Bloqueado",
            "customer_phone": "3001112233",
        },
    )
    assert blocked.status_code == 409, blocked.text

    db.execute(
        "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s,%s,'super_admin')",
        (venue, api.world["admin"]["id"]),
    )
    review = api.post(
        f"/venues/{venue}/payout-profile/review",
        "admin",
        {"status": "approved", "note": "Documentos ok"},
    )
    assert review.status_code == 200, review.text
    assert review.json()["status"] == "approved"
    assert review.json()["can_sell_online"] is True

    sold = api.client.post(
        f"/public/events/{event}/checkout",
        json={
            "ticket_type_id": tipo,
            "customer_name": "Fan Habilitado",
            "customer_phone": "3001112234",
        },
    )
    assert sold.status_code == 201, sold.text


def test_fee_preview_and_charge_freeze_platform_fee(api, db, wompi_on):
    venue, event, tipo = _paid_event(api)
    config = {
        "service_fee_cents": 5000,
        "payment_fee_pct": 3,
        "tax_pct": 0,
        "show_breakdown": True,
        "platform_fee_bps": 500,
        "platform_fee_fixed_cents": 1000,
        "platform_fee_payer": "organizer",
    }
    saved = api.client.put(
        f"/venues/{venue}/events/{event}/fee-config",
        headers=api.headers("admin"),
        json=config,
    )
    assert saved.status_code == 200, saved.text

    preview = api.get(
        f"/venues/{venue}/events/{event}/fee-preview?ticket_type_id={tipo}", "admin"
    )
    assert preview.status_code == 200, preview.text
    data = preview.json()
    assert data["base_cents"] == 100_000
    assert data["service_fee_cents"] == 5_000
    assert data["payment_fee_cents"] == 3_150
    assert data["platform_fee_cents"] == 6_000
    assert data["buyer_total_cents"] == 108_150
    assert data["organizer_net_cents"] == 99_000

    public = api.client.get(f"/public/events/{event}/fees?ticket_type_id={tipo}")
    assert public.status_code == 200, public.text
    assert public.json()["total_cents"] == 108_150
    assert public.json()["platform_fee_cents"] == 6_000

    checkout = api.client.post(
        f"/public/events/{event}/checkout",
        json={
            "ticket_type_id": tipo,
            "customer_name": "Fan Tarifa",
            "customer_phone": "3001112235",
        },
    )
    assert checkout.status_code == 201, checkout.text
    row = db.execute(
        "SELECT amount_in_cents, platform_fee_cents, organizer_net_cents, fee_breakdown"
        " FROM ticket_payments WHERE reference=%s",
        (checkout.json()["reference"],),
    ).fetchone()
    assert row["amount_in_cents"] == 108_150
    assert row["platform_fee_cents"] == 6_000
    assert row["organizer_net_cents"] == 99_000
    assert row["fee_breakdown"]["buyer_total_cents"] == 108_150


def test_platform_fee_can_be_paid_by_buyer(api):
    venue, event, tipo = _paid_event(api)
    saved = api.client.put(
        f"/venues/{venue}/events/{event}/fee-config",
        headers=api.headers("admin"),
        json={
            "service_fee_cents": 0,
            "payment_fee_pct": 0,
            "tax_pct": 0,
            "show_breakdown": True,
            "platform_fee_bps": 1000,
            "platform_fee_fixed_cents": 0,
            "platform_fee_payer": "buyer",
        },
    )
    assert saved.status_code == 200, saved.text
    preview = api.get(
        f"/venues/{venue}/events/{event}/fee-preview?ticket_type_id={tipo}", "admin"
    ).json()
    assert preview["platform_fee_cents"] == 10_000
    assert preview["buyer_total_cents"] == 110_000
    assert preview["organizer_net_cents"] == 100_000
