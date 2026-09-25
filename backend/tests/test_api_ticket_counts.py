"""Pulso agregado por evento para la franja "Todos los eventos".

Un solo GET devuelve por evento: boletas vivas (issued+redeemed), cuantas
entraron (redeemed) y el recaudo de las vivas. Las anuladas dejan de contar.
Solo el admin de la venue puede leerlo.
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
    assert counts[str(ev_busy["id"])]["active"] == 2
    # Un evento sin boletas TAMBIEN aparece (LEFT JOIN), con cero.
    assert counts[str(ev_empty["id"])]["active"] == 0
    assert counts[str(ev_empty["id"])]["revenue_cents"] == 0


def test_counts_shape_redeemed_and_revenue(api, world):
    """La respuesta es el mini-reporte de la tarjeta: vivas · dentro · recaudo.

    Mantener el shape aqui es barato: si alguien "simplifica" el endpoint de
    vuelta a un conteo plano, la franja pierde sus cifras sin que ningun test
    de frontend lo avise.
    """
    venue = world["venue_a"]
    ev = api.create_event("admin", venue, name="Mini reporte")
    t_paid = api.add_type(
        "admin",
        venue,
        ev["id"],
        name="General",
        price_cents=30000,
        is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    # Venta directa: una boleta de PAGO no puede usar cupo de promotor
    # (regla de negocio), asi que las dos se emiten sin allocation.
    api.emit(
        "admin", venue, ev["id"], ticket_type_id=t_paid["id"], allocation_id=None
    )
    ticket = api.emit(
        "admin", venue, ev["id"], ticket_type_id=t_paid["id"], allocation_id=None
    )
    # Una boleta entra por puerta: redeemed=1. El canje es funcion de DB
    # (raw_token crudo), asi que el test marca el estado directo, como el
    # resto de la suite ajusta columnas que la API no expone.
    api.run_sql(
        f"UPDATE tickets SET status = 'redeemed', redeemed_at = now() "
        f"WHERE id = {ticket['ticket_id']}"
    )

    counts = api.get(f"/venues/{venue}/events/ticket-counts", "admin").json()
    c = counts[str(ev["id"])]
    assert c["active"] == 2  # la redimida sigue viva
    assert c["redeemed"] == 1
    # Recaudo = precio de TODAS las vivas (la redimida incluida): 2 x $300.
    assert c["revenue_cents"] == 60000


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
    assert counts[str(ev["id"])]["active"] == 0


def test_promoter_cannot_read_counts(api, world):
    # Es un reporte de gestion: el promotor no lo necesita (minimo privilegio).
    res = api.get(f"/venues/{world['venue_a']}/events/ticket-counts", "promoter")
    assert res.status_code == 403
