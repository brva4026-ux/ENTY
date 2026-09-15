"""Editar y eliminar tipos de boleta y cupos de promotor.

Lo que se protege aquí no es cosmético: bajar la cantidad (o la capacidad de un
cupo) por debajo de lo ya emitido sería sobreventa, y borrar un tipo con
historial rompería la trazabilidad de esas boletas.
"""
import pytest


def _emit(api, scen, **kw):
    return api.emit(
        "promoter",
        scen["venue"],
        scen["event"],
        ticket_type_id=scen["type"],
        allocation_id=scen["allocation"]["id"],
        **kw,
    )


def _emit_payload(scen, allocation_id=None):
    return {
        "ticket_type_id": scen["type"],
        "allocation_id": scen["allocation"]["id"] if allocation_id is None else allocation_id,
        "customer_name": "Asistente",
        "customer_phone": "3001234567",
    }


# ---------------------------------------------------------------------------
# Editar tipos
# ---------------------------------------------------------------------------
def test_edit_type_name_price_and_quantity(api):
    scen = api.scenario()
    res = api.patch(
        api.type_url(scen["venue"], scen["event"], scen["type"]),
        "admin",
        {"name": "VIP", "price_cents": 45000, "quantity": 25, "is_courtesy": False},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["name"], body["price_cents"], body["quantity"], body["is_courtesy"]) == (
        "VIP",
        45000,
        25,
        False,
    )

    [only] = api.types("admin", scen["venue"], scen["event"])
    assert only["name"] == "VIP"
    assert only["quantity"] == 25
    assert only["is_active"] is True


def test_partial_edit_keeps_the_other_fields(api):
    """PATCH: solo se toca lo enviado."""
    scen = api.scenario()
    before = api.types("admin", scen["venue"], scen["event"])[0]

    res = api.patch(
        api.type_url(scen["venue"], scen["event"], scen["type"]), "admin", {"quantity": 7}
    )
    assert res.status_code == 200, res.text
    after = res.json()
    assert after["quantity"] == 7
    assert after["name"] == before["name"]
    assert after["price_cents"] == before["price_cents"]
    assert after["is_courtesy"] == before["is_courtesy"]


def test_type_quantity_cannot_drop_below_issued(api):
    scen = api.scenario()
    _emit(api, scen)
    _emit(api, scen)

    blocked = api.patch(
        api.type_url(scen["venue"], scen["event"], scen["type"]), "admin", {"quantity": 1}
    )
    assert blocked.status_code == 409
    assert "emitidas" in blocked.json()["detail"]

    # Justo en el limite ya emitido si se permite.
    ok = api.patch(
        api.type_url(scen["venue"], scen["event"], scen["type"]), "admin", {"quantity": 2}
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["quantity"] == 2


def test_voided_tickets_do_not_block_lowering_the_quantity(api):
    """Anular libera inventario: el tipo se puede ajustar a lo que sigue vivo."""
    scen = api.scenario(alloc_capacity=2)
    first = _emit(api, scen)
    _emit(api, scen)

    void = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets/{first['ticket_id']}/void",
        "admin",
        {"reason": "prueba de anulación"},
    )
    assert void.status_code == 200, void.text

    res = api.patch(
        api.type_url(scen["venue"], scen["event"], scen["type"]), "admin", {"quantity": 1}
    )
    assert res.status_code == 200, res.text


def test_renaming_to_an_existing_name_is_rejected(api):
    scen = api.scenario()
    api.add_type(
        "admin", scen["venue"], scen["event"], name="VIP", price_cents=1000, is_courtesy=False
    )

    res = api.patch(
        api.type_url(scen["venue"], scen["event"], scen["type"]), "admin", {"name": "VIP"}
    )
    assert res.status_code == 409


def test_editing_an_unknown_type_is_not_found(api):
    scen = api.scenario()
    url = api.type_url(scen["venue"], scen["event"], 999999)
    assert api.patch(url, "admin", {"quantity": 1}).status_code == 404
    assert api.delete(url, "admin").status_code == 404


# ---------------------------------------------------------------------------
# Eliminar tipos
# ---------------------------------------------------------------------------
def test_delete_unused_type_removes_the_row(api):
    scen = api.scenario()
    extra = api.add_type(
        "admin", scen["venue"], scen["event"], name="VIP", price_cents=1000, is_courtesy=False
    )

    res = api.delete(api.type_url(scen["venue"], scen["event"], extra["id"]), "admin")
    assert res.status_code == 200, res.text
    assert res.json()["archived"] is False

    ids = [t["id"] for t in api.types("admin", scen["venue"], scen["event"])]
    assert ids == [scen["type"]]


def test_delete_type_with_tickets_archives_it(api):
    scen = api.scenario()
    _emit(api, scen)

    res = api.delete(api.type_url(scen["venue"], scen["event"], scen["type"]), "admin")
    assert res.status_code == 200, res.text
    assert res.json()["archived"] is True

    [only] = api.types("admin", scen["venue"], scen["event"])
    assert only["id"] == scen["type"]
    assert only["is_active"] is False


def test_archived_type_rejects_new_tickets_and_can_be_reactivated(api):
    """`is_active` existía desde el esquema inicial pero nadie lo miraba: antes
    archivar un tipo no tenía ningún efecto real."""
    scen = api.scenario()
    url = api.type_url(scen["venue"], scen["event"], scen["type"])

    archived = api.patch(url, "admin", {"is_active": False})
    assert archived.status_code == 200, archived.text
    assert archived.json()["is_active"] is False

    blocked = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets",
        "promoter",
        _emit_payload(scen),
    )
    assert blocked.status_code == 409
    assert "archivado" in blocked.json()["detail"]

    assert api.patch(url, "admin", {"is_active": True}).status_code == 200
    _emit(api, scen)  # vuelve a emitir sin problema


# ---------------------------------------------------------------------------
# Editar y eliminar cupos
# ---------------------------------------------------------------------------
def test_allocation_capacity_can_be_raised_and_keeps_used(api):
    scen = api.scenario(alloc_capacity=5)
    _emit(api, scen)

    res = api.patch(
        api.allocation_url(scen["venue"], scen["event"], scen["allocation"]["id"]),
        "admin",
        {"capacity": 8},
    )
    assert res.status_code == 200, res.text
    assert res.json()["capacity"] == 8
    assert res.json()["issued"] == 1


def test_allocation_capacity_cannot_drop_below_used(api):
    scen = api.scenario(alloc_capacity=2)
    _emit(api, scen)
    url = api.allocation_url(scen["venue"], scen["event"], scen["allocation"]["id"])

    blocked = api.patch(url, "admin", {"capacity": 0})
    assert blocked.status_code == 409
    assert "emitidas" in blocked.json()["detail"]

    assert api.patch(url, "admin", {"capacity": 1}).status_code == 200


def test_editing_an_unknown_allocation_is_not_found(api):
    scen = api.scenario()
    url = api.allocation_url(scen["venue"], scen["event"], 999999)
    assert api.patch(url, "admin", {"capacity": 1}).status_code == 404
    assert api.delete(url, "admin").status_code == 404


def test_delete_unused_allocation_removes_the_row(api):
    scen = api.scenario()
    extra = api.set_allocation(
        "admin",
        scen["venue"],
        scen["event"],
        ticket_type_id=scen["type"],
        promoter_id=api.world["promoter2"]["id"],
        capacity=3,
    )

    res = api.delete(
        api.allocation_url(scen["venue"], scen["event"], extra["id"]), "admin"
    )
    assert res.status_code == 200, res.text
    assert res.json()["archived"] is False

    ids = [a["id"] for a in api.allocations("admin", scen["venue"], scen["event"])]
    assert ids == [scen["allocation"]["id"]]


def test_delete_allocation_with_tickets_archives_and_blocks_emission(api):
    scen = api.scenario(alloc_capacity=3)
    _emit(api, scen)
    alloc_id = scen["allocation"]["id"]

    res = api.delete(api.allocation_url(scen["venue"], scen["event"], alloc_id), "admin")
    assert res.status_code == 200, res.text
    assert res.json()["archived"] is True

    # Sigue en la lista (con su historial) pero ya no acepta boletas.
    [only] = api.allocations("admin", scen["venue"], scen["event"])
    assert only["is_active"] is False
    assert only["issued"] == 1

    blocked = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets",
        "promoter",
        _emit_payload(scen),
    )
    assert blocked.status_code == 409
    assert "archivado" in blocked.json()["detail"]


# ---------------------------------------------------------------------------
# Permisos
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("who", ["promoter", "bouncer", "outsider"])
def test_editing_types_and_allocations_is_admin_only(api, who):
    scen = api.scenario()
    type_url = api.type_url(scen["venue"], scen["event"], scen["type"])
    alloc_url = api.allocation_url(scen["venue"], scen["event"], scen["allocation"]["id"])

    assert api.patch(type_url, who, {"quantity": 1}).status_code == 403
    assert api.delete(type_url, who).status_code == 403
    assert api.patch(alloc_url, who, {"capacity": 1}).status_code == 403
    assert api.delete(alloc_url, who).status_code == 403
