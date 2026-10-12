"""Tests del reporte del evento: recaudo vivo y desglose por tipo.

El recaudo viene del snapshot de precio de cada boleta (price_cents_snapshot):
inmutable aunque el admin edite el tipo después. Solo cuentan las boletas
activas — anular o reembolsar reduce el recaudo.
"""
from datetime import datetime, timedelta, timezone


def _future_offset() -> str:
    """starts_at futuro en ISO (los eventos nuevos se crean en draft/published)."""
    return (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()


def _ticket_id_by_token(db, raw_token: str) -> int:
    row = db.execute(
        "SELECT id FROM tickets WHERE token_hash=encode(digest(%s,'sha256'),'hex')",
        (raw_token,),
    ).fetchone()
    assert row is not None
    return row["id"]

def test_report_revenue_and_by_type(api):
    """Recaudo = suma de snapshots activos; by_type respeta cantidades."""
    venue = api.world["venue_a"]

    # Evento publicado con dos tipos: pago ($300) y cortesía.
    ev = api.create_event("admin", venue, name="Reporte Event", starts_at=_future_offset())
    t_paid = api.add_type(
        "admin", venue, ev["id"],
        name="Pago", price_cents=30000, quantity=50, is_courtesy=False,
    )
    t_free = api.add_type(
        "admin", venue, ev["id"],
        name="Cortesia", price_cents=0, quantity=10, is_courtesy=True,
    )
    api.publish("admin", venue, ev["id"])

    # Venta directa: 2 boletas de pago (sin cupo de promotor).
    for i in range(2):
        res = api.post(
            f"/venues/{venue}/events/{ev['id']}/tickets",
            "admin",
            {
                "ticket_type_id": t_paid["id"],
                "customer_name": f"Pagador {i}",
                "customer_phone": "3001234567",
            },
        )
        assert res.status_code == 201, res.text

    # 1 cortesía vía cupo de promotor.
    alloc = api.set_allocation(
        "admin", venue, ev["id"],
        ticket_type_id=t_free["id"],
        promoter_id=api.world["promoter"]["id"],
        capacity=5,
    )
    api.emit(
        "promoter", venue, ev["id"],
        ticket_type_id=t_free["id"],
        allocation_id=alloc["id"],
        customer_name="Invitado cortesia",
    )

    res = api.get(f"/venues/{venue}/events/{ev['id']}/report", "admin")
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["revenue_cents"] == 60000  # 2 x $300
    assert body["issued"] == 3

    by_id = {t["name"]: t for t in body["by_type"]}
    assert by_id["Pago"]["issued"] == 2
    assert by_id["Pago"]["revenue_cents"] == 60000
    assert by_id["Pago"]["quantity"] == 50
    assert by_id["Cortesia"]["issued"] == 1
    assert by_id["Cortesia"]["revenue_cents"] == 0  # cortesía no recauda


def test_report_revenue_drops_on_void(api, db):
    """Anular una boleta reduce el recaudo (dinero vivo, no histórico)."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Void Revenue", starts_at=_future_offset())
    t = api.add_type(
        "admin", venue, ev["id"],
        name="Pago", price_cents=50000, quantity=50, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])

    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/tickets",
        "admin",
        {
            "ticket_type_id": t["id"],
            "customer_name": "Uno",
            "customer_phone": "3001234567",
        },
    )
    assert res.status_code == 201, res.text
    token1 = res.json()["raw_token"]
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/tickets",
        "admin",
        {
            "ticket_type_id": t["id"],
            "customer_name": "Dos",
            "customer_phone": "3001234567",
        },
    )
    assert res.status_code == 201, res.text

    res = api.get(f"/venues/{venue}/events/{ev['id']}/report", "admin")
    assert res.json()["revenue_cents"] == 100000

    # Anular la primera: -50000
    tid = _ticket_id_by_token(db, token1)
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/tickets/{tid}/void",
        "admin",
        {"reason": "error de digitación"},
    )
    assert res.status_code == 200, res.text

    res = api.get(f"/venues/{venue}/events/{ev['id']}/report", "admin")
    body = res.json()
    assert body["revenue_cents"] == 50000
    assert body["voided"] == 1
    assert body["issued"] == 1


def test_report_revenue_uses_snapshot_not_current_price(api):
    """Editar el precio del tipo NO cambia el recaudo ya emitido."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Snapshot Event", starts_at=_future_offset())
    t = api.add_type(
        "admin", venue, ev["id"],
        name="Pago", price_cents=10000, quantity=50, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])

    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/tickets",
        "admin",
        {
            "ticket_type_id": t["id"],
            "customer_name": "Uno",
            "customer_phone": "3001234567",
        },
    )
    assert res.status_code == 201, res.text

    # El admin sube el precio del tipo a $500 después de emitir.
    res = api.patch(
        api.type_url(venue, ev["id"], t["id"]),
        "admin",
        {"price_cents": 50000},
    )
    assert res.status_code == 200, res.text

    res = api.get(f"/venues/{venue}/events/{ev['id']}/report", "admin")
    body = res.json()
    assert body["revenue_cents"] == 10000  # snapshot, no precio nuevo
    by_type = {x["name"]: x for x in body["by_type"]}
    assert by_type["Pago"]["price_cents"] == 50000  # precio vigente del tipo
    assert by_type["Pago"]["revenue_cents"] == 10000  # pero recaudo del snapshot


def test_report_by_type_includes_empty_types(api):
    """Tipos sin boletas aparecen con issued=0 (inventario completo visible)."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Empty Type", starts_at=_future_offset())
    api.add_type(
        "admin", venue, ev["id"],
        name="VIP", price_cents=80000, quantity=10, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])

    res = api.get(f"/venues/{venue}/events/{ev['id']}/report", "admin")
    body = res.json()
    assert len(body["by_type"]) == 1
    assert body["by_type"][0]["name"] == "VIP"
    assert body["by_type"][0]["issued"] == 0
    assert body["by_type"][0]["revenue_cents"] == 0
    assert body["revenue_cents"] == 0


def test_report_forbidden_for_other_venue(api):
    """Aislamiento multi-tenant del reporte."""
    ev = api.create_event("admin", api.world["venue_a"], name="Iso", starts_at=_future_offset())
    res = api.get(
        f"/venues/{api.world['venue_b']}/events/{ev['id']}/report", "outsider"
    )
    # El outsider es admin de la venue B, pero el evento no existe en esa venue.
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Salud de puerta en el reporte (duplicados / rechazos)
# ---------------------------------------------------------------------------
def _open_night(api, name: str) -> tuple[int, int]:
    """Evento publicado y EN PUERTA, con la ventana del QR ya abierta."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=name)
    api.publish("admin", venue, ev["id"])
    # El QR se activa 60 min antes de starts_at (default): al mover el evento
    # al pasado, un canje es GRANTED y no NOT_ACTIVE.
    api.run_sql(
        f"UPDATE events SET starts_at = now() - interval '1 hour' WHERE id = {ev['id']}"
    )
    res = api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    assert res.status_code == 200, res.text
    return venue, ev["id"]


def test_report_door_health_counts_duplicates_and_rejections(api):
    """El admin ve, en vivo, cuántas boletas se reescanearon y cuántas se negaron.

    Un pico de duplicados es el síntoma de un QR reenviado/clonado: tiene que
    estar en el reporte del evento, no solo en el CSV del día siguiente.
    """
    venue, event_id = _open_night(api, "Salud de puerta")
    tipo = api.add_type(
        "admin", venue, event_id,
        name="General", price_cents=0, quantity=5, is_courtesy=True,
    )
    ticket = api.emit(
        "admin", venue, event_id, ticket_type_id=tipo["id"], allocation_id=None,
    )

    # Primer escaneo: ingresa. Segundo: duplicado (QR reenviado). Tercero:
    # token que no existe (rechazo).
    first = api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": ticket["raw_token"]},
    )
    assert first.status_code == 200 and first.json()["redeemed"] is True, first.text
    dup = api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": ticket["raw_token"]},
    )
    assert dup.status_code == 200, dup.text
    bad = api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": "no-existe-este-token"},
    )
    assert bad.status_code in (200, 404), bad.text

    body = api.get(f"/venues/{venue}/events/{event_id}/report", "admin").json()
    assert body["door_duplicates"] == 1
    assert body["door_rejected"] == 1


def test_report_door_health_not_leaked_to_promoter(api):
    """El promotor NO ve la salud de puerta: es dato operativo del negocio."""
    venue, event_id = _open_night(api, "Salud privada")
    tipo = api.add_type(
        "admin", venue, event_id,
        name="General", price_cents=0, quantity=5, is_courtesy=True,
    )
    ticket = api.emit(
        "admin", venue, event_id, ticket_type_id=tipo["id"], allocation_id=None,
    )
    api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": ticket["raw_token"]},
    )
    api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": ticket["raw_token"]},
    )

    body = api.get(f"/venues/{venue}/events/{event_id}/report", "promoter").json()
    assert body["door_duplicates"] == 0
    assert body["door_rejected"] == 0

