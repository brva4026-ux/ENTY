"""Avisos de cambio de evento y salud operativa de la noche."""
from datetime import datetime, timedelta

from tests.test_ticket_operational_history import _emit_paid, _paid_event


def test_change_notice_counts_buyers_and_reaches_public_ticket(api):
    venue, event, kind = _paid_event(api)
    ticket = _emit_paid(api, venue, event, kind)

    current = next(
        e
        for e in api.get(f"/venues/{venue}/events", "admin").json()
        if e["id"] == event
    )
    new_start = (
        datetime.fromisoformat(current["starts_at"]) + timedelta(hours=24)
    ).isoformat()
    res = api.patch(
        f"/venues/{venue}/events/{event}",
        "admin",
        {"starts_at": new_start, "location": "Nuevo lugar"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["affected_tickets"] == 1
    assert body["affected_buyers"] == 1
    notice = body["change_notice"]
    assert notice["title"] == "El evento cambió"
    assert "antes" in notice["message"] and "ahora" in notice["message"]
    assert "Tu boleta sigue válida" in notice["message"]

    page = api.client.get(f"/public/tickets/{ticket['raw_token']}")
    assert page.status_code == 200, page.text
    assert "Aviso del organizador" in page.text
    assert "Nuevo lugar" in page.text

    preview = api.client.post(
        "/public/tickets/preview", json={"raw_token": ticket["raw_token"]}
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["change_notice"]["title"] == "El evento cambió"

    access = api.client.post(
        "/public/my-tickets/access", json={"raw_token": ticket["raw_token"]}
    )
    assert access.status_code == 200, access.text
    ticket_out = access.json()["tickets"][0]
    assert ticket_out["change_notice"]["title"] == "El evento cambió"


def test_cancelled_event_notice_tells_buyer_not_to_attend(api):
    venue, event, kind = _paid_event(api)
    ticket = _emit_paid(api, venue, event, kind)

    res = api.post(f"/venues/{venue}/events/{event}/cancel", "admin")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["affected_tickets"] == 1
    assert body["change_notice"]["title"] == "Evento cancelado"
    assert "No se permitirá el ingreso" in body["change_notice"]["message"]

    page = api.client.get(f"/public/tickets/{ticket['raw_token']}")
    assert "El evento fue cancelado" in page.text


def test_night_health_reports_devices_payments_and_incidents(api):
    venue, event, _kind = _paid_event(api)
    live = api.post(f"/venues/{venue}/events/{event}/live", "admin")
    assert live.status_code == 200, live.text

    res = api.get(f"/venues/{venue}/events/{event}/night-health", "admin")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["event_id"] == event
    assert body["active_devices"] == 0
    assert body["stale_devices"] == 0
    assert body["pending_payments_count"] == 0
    assert body["unfulfilled_payments_count"] == 0
    assert body["open_incidents"] == 0
    assert body["devices"] == []
