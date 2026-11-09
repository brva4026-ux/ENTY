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


# ---------------------------------------------------------------------------
# Ley de Tesler: distribuir cupos en UNA operación (no P formularios)
# ---------------------------------------------------------------------------


def test_bulk_distributes_exactly_and_evenly(api):
    """El reparto en lote es exacto: la suma de los cupos = total pedido, y la
    diferencia de la división no se pierde (se reparte 1 a 1 entre los primeros)."""
    scen = api.scenario()
    res = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/allocations/bulk",
        "admin",
        {
            "ticket_type_id": scen["type"],
            "promoter_ids": [
                api.world["promoter"]["id"],
                api.world["promoter2"]["id"],
            ],
            "total_capacity": 11,
        },
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["per_promoter"] == 5
    assert body["remainder"] == 1
    caps = sorted(a["capacity"] for a in body["allocations"])
    assert caps == [5, 6], "la suma debe ser exacta (11), no 10"
    assert all(a["issued"] == 0 for a in body["allocations"])


def test_bulk_is_idempotent_and_resets_capacity(api):
    """Reenviar el mismo reparto no duplica filas: hace upsert de la capacidad."""
    scen = api.scenario()
    url = f"/venues/{scen['venue']}/events/{scen['event']}/allocations/bulk"
    payload = {
        "ticket_type_id": scen["type"],
        "promoter_ids": [api.world["promoter"]["id"]],
        "total_capacity": 4,
    }
    first = api.post(url, "admin", payload).json()
    assert first["allocations"][0]["capacity"] == 4

    payload["total_capacity"] = 9
    second = api.post(url, "admin", payload).json()
    assert second["allocations"][0]["capacity"] == 9

    allocs = api.allocations("admin", scen["venue"], scen["event"])
    assert len(allocs) == 1, "el reparto repetido no debe duplicar el cupo"


def test_bulk_rejects_foreign_promoter(api):
    """Un promotor que no es de la venue se rechaza: no se crea ningún cupo."""
    scen = api.scenario()
    res = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/allocations/bulk",
        "admin",
        {
            "ticket_type_id": scen["type"],
            "promoter_ids": [api.world["outsider"]["id"]],
            "total_capacity": 5,
        },
    )
    assert res.status_code == 409, res.text
    allocs = api.allocations("admin", scen["venue"], scen["event"])
    assert all(a["promoter_id"] != api.world["outsider"]["id"] for a in allocs)


def test_bulk_requires_admin(api):
    scen = api.scenario()
    res = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/allocations/bulk",
        "promoter",
        {
            "ticket_type_id": scen["type"],
            "promoter_ids": [api.world["promoter"]["id"]],
            "total_capacity": 5,
        },
    )
    assert res.status_code == 403
