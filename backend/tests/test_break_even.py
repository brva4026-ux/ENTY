"""Punto de equilibrio: costos estimados, registrados y caja real."""
import uuid


def _event(api, *, capacity=10):
    venue = api.world["venue_a"]
    ev = api.create_event(
        "admin", venue, name=f"Equilibrio {uuid.uuid4().hex[:6]}", capacity=capacity
    )
    kind = api.add_type(
        "admin", venue, ev["id"], name="General", price_cents=100000,
        quantity=capacity, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    return venue, ev["id"], kind["id"]


def _cost(api, venue, event, *, amount, status="estimated", description="Costo"):
    res = api.post(
        f"/venues/{venue}/events/{event}/costs",
        "admin",
        {
            "description": description,
            "category": "produccion",
            "amount_cents": amount,
            "status": status,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def _break_even(api, venue, event):
    res = api.get(f"/venues/{venue}/events/{event}/break-even", "admin")
    assert res.status_code == 200, res.text
    return res.json()


def _sell(api, venue, event, type_id, name):
    res = api.post(
        f"/venues/{venue}/events/{event}/tickets",
        "admin",
        {
            "ticket_type_id": type_id,
            "customer_name": name,
            "customer_phone": "3001234567",
        },
    )
    assert res.status_code == 201, res.text


def test_break_even_tracks_estimate_commitment_and_cash(api):
    venue, event, kind = _event(api, capacity=5)
    _cost(api, venue, event, amount=800000, status="estimated")

    first = _break_even(api, venue, event)
    assert first["target_basis"] == "estimado"
    assert first["target_cents"] == 800000
    assert first["collected_cents"] == 0
    assert first["remaining_cents"] == 800000
    assert first["tickets_remaining"] == 8
    assert first["status"] == "en_riesgo"

    _sell(api, venue, event, kind, "Ana")
    _sell(api, venue, event, kind, "Beto")
    second = _break_even(api, venue, event)
    assert second["collected_cents"] == 200000
    assert second["remaining_cents"] == 600000
    assert second["tickets_remaining"] == 6
    assert second["covered_pct"] == 25.0

    # Un costo registrado reemplaza la estimación como base del equilibrio.
    _cost(api, venue, event, amount=400000, status="committed")
    third = _break_even(api, venue, event)
    assert third["target_basis"] == "registrado"
    assert third["target_cents"] == 400000
    assert third["estimated_cents"] == 800000
    assert third["committed_cents"] == 400000
    assert third["remaining_cents"] == 200000
    # Con las 3 boletas que quedan a 100.000, la proyección cubre el costo.
    assert third["projected_revenue_cents"] == 500000
    assert third["status"] == "en_camino"

    # Pagar un costo no lo saca del total registrado.
    _cost(api, venue, event, amount=600000, status="paid")
    fourth = _break_even(api, venue, event)
    assert fourth["committed_cents"] == 1000000
    assert fourth["paid_cents"] == 600000
    assert fourth["target_cents"] == 1000000
    assert fourth["remaining_cents"] == 800000
    assert fourth["status"] == "en_riesgo"


def test_cost_update_and_delete(api):
    venue, event, _ = _event(api)
    cost = _cost(api, venue, event, amount=100000)
    updated = api.patch(
        f"/venues/{venue}/events/{event}/costs/{cost['id']}",
        "admin",
        {"amount_cents": 250000, "status": "committed", "notes": "Factura 12"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["amount_cents"] == 250000
    assert updated.json()["status"] == "committed"
    assert updated.json()["notes"] == "Factura 12"
    assert _break_even(api, venue, event)["target_cents"] == 250000

    deleted = api.delete(
        f"/venues/{venue}/events/{event}/costs/{cost['id']}", "admin"
    )
    assert deleted.status_code == 200, deleted.text
    assert _break_even(api, venue, event)["target_cents"] == 0
    assert _break_even(api, venue, event)["status"] == "sin_costos"


def test_break_even_is_admin_only(api):
    venue, event, _ = _event(api)
    assert api.get(f"/venues/{venue}/events/{event}/break-even", "promoter").status_code == 403
    assert api.post(
        f"/venues/{venue}/events/{event}/costs",
        "promoter",
        {"description": "No", "amount_cents": 1},
    ).status_code == 403
