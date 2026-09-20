"""Duplicar evento: la recurrencia semanal ("Viernes Electronico") en un clic.

El endpoint copia evento + tipos ACTIVOS + cupos ACTIVOS en un solo statement
SQL (o se copia completo o nada). Aqui se verifica el contrato:

- Nace draft (nunca hereda published/live), nombre "(copia)", apertura +7 dias,
  sin cierre (se define al editar) y SIN boletas (serian entradas gratis).
- Los cupos del duplicado apuntan a los tipos NUEVOS (no a los del original).
- Tipos archivados y cupos inactivos NO se copian.
- Solo admin de la venue; la venue ajena y el promotor no duplican.
"""
from datetime import datetime


def _setup_full_event(api, world):
    ev = api.create_event(
        "admin", world["venue_a"], name="Viernes Electronico"
    )
    general = api.add_type(
        "admin", world["venue_a"], ev["id"],
        name="General", price_cents=50000, quantity=80, is_courtesy=False,
    )
    cortesia = api.add_type(
        "admin", world["venue_a"], ev["id"], name="Cortesia", quantity=10
    )
    api.set_allocation(
        "admin", world["venue_a"], ev["id"],
        ticket_type_id=general["id"], promoter_id=world["promoter"]["id"],
        capacity=5,
    )
    api.set_allocation(
        "admin", world["venue_a"], ev["id"],
        ticket_type_id=cortesia["id"], promoter_id=world["promoter2"]["id"],
        capacity=3,
    )
    return ev, general, cortesia


def test_duplicate_copies_draft_types_and_allocations(api, world):
    ev, _g, _c = _setup_full_event(api, world)

    res = api.post(
        api.event_url(world["venue_a"], ev["id"]) + "/duplicate", "admin"
    )
    assert res.status_code == 201, res.text
    dup = res.json()

    assert dup["id"] != ev["id"]
    assert dup["name"] == "Viernes Electronico (copia)"
    assert dup["status"] == "draft"
    assert dup["capacity"] == ev["capacity"]
    assert dup["ends_at"] is None

    orig = datetime.fromisoformat(ev["starts_at"])
    nueva = datetime.fromisoformat(dup["starts_at"])
    assert (nueva - orig).days == 7

    # Tipos: mismos nombres/precios/cantidades, IDs NUEVOS.
    types = api.get(
        api.event_url(world["venue_a"], dup["id"]) + "/types", "admin"
    ).json()
    assert {(t["name"], t["price_cents"], t["quantity"]) for t in types} == {
        ("General", 50000, 80),
        ("Cortesia", 0, 10),
    }

    # Cupos: mismos promotores y capacidades, apuntando a los tipos nuevos.
    allocs = api.get(
        api.event_url(world["venue_a"], dup["id"]) + "/allocations", "admin"
    ).json()
    assert {
        (a["promoter_id"], a["capacity"]) for a in allocs
    } == {
        (world["promoter"]["id"], 5),
        (world["promoter2"]["id"], 3),
    }
    assert {a["ticket_type_id"] for a in allocs} == {t["id"] for t in types}


def test_duplicate_skips_archived_type_and_inactive_allocation(api, world):
    ev, general, vieja = _setup_full_event(api, world)
    # Archivar el tipo "Cortesia" y su cupo.
    res = api.patch(
        api.event_url(world["venue_a"], ev["id"]) + f"/types/{vieja['id']}",
        "admin",
        {"is_active": False},
    )
    assert res.status_code == 200, res.text
    allocs_orig = api.get(
        api.event_url(world["venue_a"], ev["id"]) + "/allocations", "admin"
    ).json()
    alloc_cortesia = next(
        a for a in allocs_orig
        if a["ticket_type_id"] == vieja["id"]
    )
    res = api.patch(
        api.event_url(world["venue_a"], ev["id"])
        + f"/allocations/{alloc_cortesia['id']}",
        "admin",
        {"is_active": False},
    )
    assert res.status_code == 200, res.text

    res = api.post(
        api.event_url(world["venue_a"], ev["id"]) + "/duplicate", "admin"
    )
    assert res.status_code == 201, res.text
    dup = res.json()

    types = api.get(
        api.event_url(world["venue_a"], dup["id"]) + "/types", "admin"
    ).json()
    assert {t["name"] for t in types} == {"General"}

    allocs = api.get(
        api.event_url(world["venue_a"], dup["id"]) + "/allocations", "admin"
    ).json()
    assert {a["promoter_id"] for a in allocs} == {world["promoter"]["id"]}


def test_duplicate_carries_no_tickets(api, world):
    ev, general, _c = _setup_full_event(api, world)
    allocs = api.get(
        api.event_url(world["venue_a"], ev["id"]) + "/allocations", "admin"
    ).json()
    alloc = next(
        a for a in allocs if a["ticket_type_id"] == general["id"]
    )
    res = api.post(
        api.event_url(world["venue_a"], ev["id"]) + "/publish", "admin"
    )
    assert res.status_code == 200, res.text
    # Boleta de PAGO via venta directa del admin (una pagada no puede usar
    # cupo de promotor). El objetivo del test es el duplicado, no el cupo.
    emitida = api.emit(
        "admin", world["venue_a"], ev["id"],
        ticket_type_id=general["id"], allocation_id=None,
        customer_name="Invitado Original",
    )
    assert emitida["ticket_id"] > 0

    res = api.post(
        api.event_url(world["venue_a"], ev["id"]) + "/duplicate", "admin"
    )
    assert res.status_code == 201, res.text
    dup = res.json()

    report = api.get(
        api.event_url(world["venue_a"], dup["id"]) + "/report", "admin"
    ).json()
    assert report["issued"] == 0
    tickets = api.get(
        api.event_url(world["venue_a"], dup["id"]) + "/tickets", "admin"
    ).json()
    assert tickets == []


def test_duplicate_permissions(api, world):
    ev, _g, _c = _setup_full_event(api, world)
    url = api.event_url(world["venue_a"], ev["id"]) + "/duplicate"

    # El promotor no duplica; el admin de OTRA venue tampoco.
    assert api.post(url, "promoter").status_code == 403
    assert api.post(url, "outsider").status_code == 403
    assert api.post(url, "bouncer").status_code == 403


def test_duplicate_missing_event_404(api, world):
    res = api.post(
        f"/venues/{world['venue_a']}/events/999999/duplicate", "admin"
    )
    assert res.status_code == 404
