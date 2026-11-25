"""Acreditaciones operativas y arqueo por cajero."""
from datetime import datetime, timedelta

from tests.test_ticket_operational_history import _emit_paid, _paid_event


def _create(api, venue, event, **extra):
    payload = {
        "holder_name": "Prensa Central",
        "category": "prensa",
        "zone": "Sala de prensa",
        "entries_allowed": 1,
    }
    payload.update(extra)
    return api.post(
        f"/venues/{venue}/events/{event}/accreditations", "admin", payload
    )


def test_accreditation_redeems_without_consuming_capacity(api):
    venue, event, _kind = _paid_event(api)
    api.post(f"/venues/{venue}/events/{event}/live", "admin")

    created = _create(api, venue, event)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["raw_token"]
    assert body["status"] == "active"
    assert body["entries_used"] == 0

    listed = api.get(f"/venues/{venue}/events/{event}/accreditations", "admin")
    assert listed.status_code == 200, listed.text
    assert [a["id"] for a in listed.json()] == [body["id"]]
    assert "raw_token" not in listed.json()[0]

    first = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": body["raw_token"], "door_id": "prensa"},
    )
    assert first.status_code == 200, first.text
    assert first.json()["code"] == "GRANTED"
    assert first.json()["customer_name"] == "Prensa Central"
    assert "prensa" in first.json()["ticket_type"].lower()

    second = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": body["raw_token"]},
    )
    assert second.status_code == 200, second.text
    assert second.json()["code"] == "ALREADY_REDEEMED"

    report = api.get(f"/venues/{venue}/events/{event}/report", "admin")
    assert report.status_code == 200, report.text
    # La acreditación no es una boleta: no emite, no ingresa al aforo.
    assert report.json()["issued"] == 0
    assert report.json()["redeemed"] == 0


def test_accreditation_honors_window_and_revocation(api):
    venue, event, _kind = _paid_event(api)
    api.post(f"/venues/{venue}/events/{event}/live", "admin")

    future = (datetime.now().astimezone() + timedelta(hours=2)).isoformat()
    created = _create(api, venue, event, valid_from=future)
    assert created.status_code == 201, created.text
    body = created.json()

    early = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": body["raw_token"]},
    )
    assert early.status_code == 200, early.text
    assert early.json()["code"] == "NOT_ACTIVE"

    revoked = api.delete(
        f"/venues/{venue}/events/{event}/accreditations/{body['id']}", "admin"
    )
    assert revoked.status_code == 200, revoked.text

    after = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": body["raw_token"]},
    )
    assert after.status_code == 200, after.text
    assert after.json()["code"] == "NOT_VALID"


def test_box_office_report_groups_sales_by_cashier(api):
    venue, event, kind = _paid_event(api)
    _emit_paid(api, venue, event, kind)

    report = api.get(f"/venues/{venue}/events/{event}/report", "admin")
    assert report.status_code == 200, report.text
    rows = report.json()["by_seller"]
    assert len(rows) == 1
    assert rows[0]["full_name"] == "Usuario admin"
    assert rows[0]["payment_method"] == "efectivo"
    assert rows[0]["tickets"] == 1
    assert rows[0]["revenue_cents"] == 5000000
