"""Contadores agregados de boletas activas por evento.

La franja "Todos los eventos" del admin muestra el pulso de cada evento sin
abrirlo: un solo GET devuelve {event_id: activas}. "Activas" = issued +
redeemed (las vivas), igual que el reporte de puerta; las anuladas dejan de
contar. Solo el admin de la venue puede leerlo.
"""
import pytest


def test_counts_active_tickets_per_event(api, world):
    venue = world["venue_a"]

    ev_busy = api.create_event("admin", venue, name="Lleno")
    ev_empty = api.create_event("admin", venue, name="Vacio")

    t = api.add_type("admin", venue, ev_busy["id"])
    api.publish("admin", venue, ev_busy["id"])  # emitir exige published|live
    a = api.set_allocation(
        "admin",
        venue,
        ev_busy["id"],
        ticket_type_id=t["id"],
        promoter_id=world["promoter"]["id"],
        capacity=5,
    )
    api.emit(
        "promoter", venue, ev_busy["id"], ticket_type_id=t["id"], allocation_id=a["id"]
    )
    api.emit(
        "promoter", venue, ev_busy["id"], ticket_type_id=t["id"], allocation_id=a["id"]
    )

    res = api.get(f"/venues/{venue}/events/ticket-counts", "admin")
    assert res.status_code == 200, res.text
    counts = res.json()
    # La clave es el id del evento (string, como viene de JSON).
    assert counts[str(ev_busy["id"])] == 2
    # Un evento sin boletas TAMBIEN aparece (LEFT JOIN), con cero.
    assert counts[str(ev_empty["id"])] == 0


def test_voided_tickets_stop_counting(api, world):
    venue = world["venue_a"]
    ev = api.create_event("admin", venue, name="Con anulada")
    t = api.add_type("admin", venue, ev["id"])
    api.publish("admin", venue, ev["id"])  # emitir exige published|live
    a = api.set_allocation(
        "admin",
        venue,
        ev["id"],
        ticket_type_id=t["id"],
        promoter_id=world["promoter"]["id"],
        capacity=5,
    )
    ticket = api.emit(
        "promoter", venue, ev["id"], ticket_type_id=t["id"], allocation_id=a["id"]
    )

    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/tickets/{ticket['ticket_id']}/void",
        "admin",
        {"reason": "Error de digitacion"},
    )
    assert res.status_code == 200, res.text

    counts = api.get(f"/venues/{venue}/events/ticket-counts", "admin").json()
    assert counts[str(ev["id"])] == 0


def test_promoter_cannot_read_counts(api, world):
    # Es un reporte de gestion: el promotor no lo necesita (minimo privilegio).
    res = api.get(f"/venues/{world['venue_a']}/events/ticket-counts", "promoter")
    assert res.status_code == 403
