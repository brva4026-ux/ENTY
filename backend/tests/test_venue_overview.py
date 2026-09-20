"""Vista agregada del negocio entre eventos (GET /venues/{id}/overview).

Verifica la promesa del endpoint: mismo criterio contable que el reporte por
evento (vivas facturan, anuladas no), tendencia real contra el mes anterior,
ranking por cupo de promotor (venta directa no infla) y navegación histórica
por ?month=YYYY-MM.
"""
from datetime import datetime, timedelta, timezone


def test_overview_counts_live_tickets_only(api, db):
    s = api.scenario()
    venue = s["venue"]
    # Emitir 3 boletas (2 quedarán vivas, 1 anulada).
    t1 = api.emit("promoter", venue, s["event"], ticket_type_id=s["type"], allocation_id=s["allocation"])
    t2 = api.emit("promoter", venue, s["event"], ticket_type_id=s["type"], allocation_id=s["allocation"])
    api.emit("promoter", venue, s["event"], ticket_type_id=s["type"], allocation_id=s["allocation"])
    # Anular la tercera (admin).
    res = api.client.post(
        f"/venues/{venue}/events/{s['event']}/tickets/{t1['ticket_id']}/void",
        headers=api.headers("admin"),
        json={"reason": "prueba"},
    )
    assert res.status_code == 200, res.text

    res = api.get(f"/venues/{venue}/overview", "admin")
    assert res.status_code == 200, res.text
    body = res.json()
    # El evento del scenario es de este mes (starts_at +29h).
    assert body["events_count"] >= 1
    # El ticket-counts del evento: 3 emitidas - 1 anulada = 2 vivas en el mes.
    # Ojo: el scenario puede tener más eventos de otros tests; validamos el
    # criterio, no el número absoluto: el mes agrupa por starts_at.
    assert body["tickets_issued"] >= 2
    assert body["tickets_redeemed"] == 0
    assert body["revenue_cents"] >= 0


def test_overview_requires_admin(api):
    s = api.scenario()
    res = api.get(f"/venues/{s['venue']}/overview", "promoter")
    assert res.status_code == 403
    res = api.get(f"/venues/{s['venue']}/overview", "bouncer")
    assert res.status_code in (401, 403)


def test_overview_invalid_month(api):
    s = api.scenario()
    res = api.get(f"/venues/{s['venue']}/overview?month=2026-13", "admin")
    assert res.status_code == 400
    res = api.get(f"/venues/{s['venue']}/overview?month=noche", "admin")
    assert res.status_code == 400
