"""Cupo usado por el promotor, visto desde la API (test de regresión).

Antes `AllocationOut` no exponía `issued` y `list_allocations` no lo calculaba,
así que la UI mostraba siempre "0 de Y" aunque el promotor ya hubiera emitido
boletas: el requisito de negocio "has usado X de Y" nunca se cumplía.

El criterio de "usada" es el mismo que usa `emit_ticket()` para rechazar la
sobreventa: cuentan las boletas que NO están `voided` ni `refunded`.
"""


def test_new_allocation_starts_at_zero(api):
    scen = api.scenario(alloc_capacity=5)
    assert scen["allocation"]["issued"] == 0
    assert scen["allocation"]["capacity"] == 5


def test_issued_counts_emitted_tickets(api):
    scen = api.scenario(alloc_capacity=5)

    for name in ("Uno", "Dos"):
        api.emit(
            "promoter",
            scen["venue"],
            scen["event"],
            ticket_type_id=scen["type"],
            allocation_id=scen["allocation"]["id"],
            customer_name=name,
        )

    [alloc] = api.allocations("admin", scen["venue"], scen["event"])
    assert alloc["issued"] == 2
    assert alloc["capacity"] == 5


def test_promoter_sees_own_used_quota(api):
    """El promotor es el consumidor real del dato, no solo el admin."""
    scen = api.scenario(alloc_capacity=3)
    api.emit(
        "promoter",
        scen["venue"],
        scen["event"],
        ticket_type_id=scen["type"],
        allocation_id=scen["allocation"]["id"],
    )

    [alloc] = api.allocations("promoter", scen["venue"], scen["event"])
    assert alloc["promoter_id"] == api.world["promoter"]["id"]
    assert alloc["issued"] == 1


def test_issued_is_counted_per_allocation(api):
    """El consumo de una promotora no infla el medidor de la otra."""
    scen = api.scenario(alloc_capacity=5)
    second = api.set_allocation(
        "admin",
        scen["venue"],
        scen["event"],
        ticket_type_id=scen["type"],
        promoter_id=api.world["promoter2"]["id"],
        capacity=4,
    )

    for _ in range(2):
        api.emit(
            "promoter",
            scen["venue"],
            scen["event"],
            ticket_type_id=scen["type"],
            allocation_id=scen["allocation"]["id"],
        )
    api.emit(
        "promoter2",
        scen["venue"],
        scen["event"],
        ticket_type_id=scen["type"],
        allocation_id=second["id"],
    )

    by_id = {a["id"]: a for a in api.allocations("admin", scen["venue"], scen["event"])}
    assert by_id[scen["allocation"]["id"]]["issued"] == 2
    assert by_id[second["id"]]["issued"] == 1


def test_voided_ticket_frees_the_quota(api):
    """Anular libera el cupo: el medidor debe bajar, no quedarse congelado."""
    scen = api.scenario(alloc_capacity=1)
    ticket = api.emit(
        "promoter",
        scen["venue"],
        scen["event"],
        ticket_type_id=scen["type"],
        allocation_id=scen["allocation"]["id"],
    )

    [alloc] = api.allocations("admin", scen["venue"], scen["event"])
    assert alloc["issued"] == 1

    res = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets/{ticket['ticket_id']}/void",
        "admin",
        {"reason": "prueba de anulación"},
    )
    assert res.status_code == 200, res.text

    [alloc] = api.allocations("admin", scen["venue"], scen["event"])
    assert alloc["issued"] == 0


def test_upserting_capacity_keeps_issued(api):
    """Reasignar el cupo (ON CONFLICT DO UPDATE) no debe perder el conteo."""
    scen = api.scenario(alloc_capacity=5)
    api.emit(
        "promoter",
        scen["venue"],
        scen["event"],
        ticket_type_id=scen["type"],
        allocation_id=scen["allocation"]["id"],
    )

    updated = api.set_allocation(
        "admin",
        scen["venue"],
        scen["event"],
        ticket_type_id=scen["type"],
        promoter_id=api.world["promoter"]["id"],
        capacity=9,
    )
    assert updated["capacity"] == 9
    assert updated["issued"] == 1
