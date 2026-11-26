"""Migración guiada, lote, búsqueda, comprobante y salida (mig 073)."""
import base64
import uuid


def _tag():
    return uuid.uuid4().hex[:6]


def _event(api, capacity=30):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Onboarding {_tag()}", capacity=capacity)
    api.publish("admin", venue, ev["id"])
    fresh = api.get(f"/venues/{venue}/events", "admin")
    assert fresh.status_code == 200, fresh.text
    return venue, next(x for x in fresh.json() if x["id"] == ev["id"])


def _type(api, venue, event, quantity=30, price=50000):
    res = api.post(
        f"/venues/{venue}/events/{event}/types",
        "admin",
        {"name": "General", "price_cents": price, "quantity": quantity,
         "is_courtesy": False},
    )
    assert res.status_code == 201, res.text
    return res.json()


def _sell(api, venue, event, type_id, name="Ana"):
    res = api.post(
        f"/venues/{venue}/events/{event}/tickets",
        "admin",
        {"ticket_type_id": type_id, "customer_name": name,
         "customer_phone": "3001234567"},
    )
    assert res.status_code == 201, res.text
    return res.json()


def _csv(*rows):
    return base64.b64encode("\n".join(rows).encode()).decode()


def test_guided_event_import_preview_apply_and_dedupe(api):
    venue = api.world["venue_a"]
    name = f"Feria {_tag()}"
    content = _csv(
        "nombre,fecha,hora,aforo,lugar,categoria",
        f"{name},2027-03-14,20:00,120,Centro,Cultural",
        ",2027-03-15,20:00,80,Centro,Cultural",
    )
    preview = api.post(
        f"/venues/{venue}/imports/preview",
        "admin",
        {"kind": "events", "filename": "eventos.csv", "content_base64": content},
    )
    assert preview.status_code == 200, preview.text
    rows = preview.json()["rows"]
    assert rows[0]["status"] == "valid"
    assert rows[1]["status"] == "error"

    apply = api.post(
        f"/venues/{venue}/imports/apply",
        "admin",
        {
            "kind": "events",
            "filename": "eventos.csv",
            "rows": [
                {"row_number": 2, "data": rows[0]["data"]},
                {
                    "row_number": 3,
                    "data": {
                        **rows[1]["data"],
                        "name": f"Otra {_tag()}",
                        "starts_at": "2027-03-15T20:00:00+00:00",
                        "capacity": 40,
                    },
                },
            ],
        },
    )
    assert apply.status_code == 200, apply.text
    assert apply.json()["imported"] == 2
    assert apply.json()["errors"] == 0

    again = api.post(
        f"/venues/{venue}/imports/preview",
        "admin",
        {"kind": "events", "filename": "eventos.csv", "content_base64": content},
    )
    assert again.status_code == 200, again.text
    assert again.json()["rows"][0]["status"] == "duplicate"


def test_guided_guest_import_corrects_row_and_marks_duplicate(api):
    venue, ev = _event(api)
    email = f"{_tag()}@ejemplo.com"
    content = _csv(
        "nombre,correo,telefono",
        f"Camila {_tag()},sin-arroba,3001112233",
        f"Daniel {_tag()},{email},3009998877",
    )
    preview = api.post(
        f"/venues/{venue}/imports/preview",
        "admin",
        {"kind": "guests", "event_id": ev["id"], "filename": "invitados.csv",
         "content_base64": content},
    )
    assert preview.status_code == 200, preview.text
    rows = preview.json()["rows"]
    assert rows[0]["status"] == "error"
    assert rows[1]["status"] == "valid"

    fixed = {
        **rows[0]["data"],
        "name": f"Camila {_tag()}",
        "email": f"corregido-{_tag()}@ejemplo.com",
        "phone": "3001112233",
    }
    apply = api.post(
        f"/venues/{venue}/imports/apply",
        "admin",
        {"kind": "guests", "event_id": ev["id"], "filename": "invitados.csv",
         "rows": [
             {"row_number": rows[0]["row_number"], "data": fixed},
             {"row_number": rows[1]["row_number"], "data": rows[1]["data"]},
         ]},
    )
    assert apply.status_code == 200, apply.text
    assert apply.json()["imported"] == 2

    again = api.post(
        f"/venues/{venue}/imports/preview",
        "admin",
        {"kind": "guests", "event_id": ev["id"], "filename": "invitados.csv",
         "content_base64": content},
    )
    assert again.status_code == 200, again.text
    statuses = {
        row["data"].get("email"): row["status"] for row in again.json()["rows"]
    }
    assert statuses[email] == "duplicate"


def test_bulk_pause_preview_and_apply(api):
    venue, ev = _event(api)
    tipo = _type(api, venue, ev["id"])
    _sell(api, venue, ev["id"], tipo["id"])

    preview = api.post(
        f"/venues/{venue}/events/{ev['id']}/bulk/preview",
        "admin",
        {"entity": "ticket_types", "ids": [tipo["id"]], "action": "pause"},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["count"] == 1
    assert body["issued_tickets"] == 1
    assert body["affected"][0]["name"] == "General"

    apply = api.post(
        f"/venues/{venue}/events/{ev['id']}/bulk/apply",
        "admin",
        {"entity": "ticket_types", "ids": [tipo["id"]], "action": "pause"},
    )
    assert apply.status_code == 200, apply.text
    assert apply.json()["is_active"] is False


def test_global_search_finds_event_person_and_action(api):
    venue, ev = _event(api)
    found = api.get(f"/search?q={ev['name']}&venue_id={venue}", "admin")
    assert found.status_code == 200, found.text
    kinds = {item["kind"] for item in found.json()["items"]}
    assert "event" in kinds

    action = api.get("/search?q=importar&venue_id=" + str(venue), "admin")
    assert action.status_code == 200, action.text
    urls = [item["url"] for item in action.json()["items"]]
    assert any("tab=importar" in url for url in urls)


def test_purchase_receipt_returns_html_for_sold_ticket(api):
    venue, ev = _event(api)
    tipo = _type(api, venue, ev["id"])
    sale = _sell(api, venue, ev["id"], tipo["id"])
    assert sale["raw_token"]
    res = api.client.post(
        "/public/purchase-receipt", json={"raw_token": sale["raw_token"]}
    )
    assert res.status_code == 200, res.text
    assert "text/html" in res.headers["content-type"]
    assert "Comprobante" in res.text
    assert "Ana" in res.text
    assert sale["raw_token"] not in res.text


def test_exit_summary_and_export_are_scoped_to_venue(api):
    venue, ev = _event(api)
    tipo = _type(api, venue, ev["id"])
    _sell(api, venue, ev["id"], tipo["id"])
    summary = api.get(f"/venues/{venue}/exit-summary", "admin")
    assert summary.status_code == 200, summary.text
    data = summary.json()
    assert data["sold_tickets"] >= 1
    assert data["gross_cents"] >= 50000
    assert data["future_events"] >= 1

    export = api.get(f"/venues/{venue}/export.json", "admin")
    assert export.status_code == 200, export.text
    assert "enty-venue-export" in export.text
    assert ev["name"] in export.text
    assert "token_hash" not in export.text

    denied = api.get(f"/venues/{venue}/export.json", "outsider")
    assert denied.status_code in (403, 404)


def test_event_update_conflict_returns_current_version(api):
    venue, ev = _event(api)
    path = f"/venues/{venue}/events/{ev['id']}"
    first = api.client.patch(
        path,
        headers=api.headers("admin"),
        json={"name": "Primera edición", "expected_updated_at": ev["updated_at"]},
    )
    assert first.status_code == 200, first.text

    stale = api.client.patch(
        path,
        headers=api.headers("admin"),
        json={"name": "Edición tardía", "expected_updated_at": ev["updated_at"]},
    )
    assert stale.status_code == 409, stale.text
    detail = stale.json()["detail"]
    assert detail["current"]["name"] == "Primera edición"
    assert detail["current"]["updated_at"] != ev["updated_at"]
