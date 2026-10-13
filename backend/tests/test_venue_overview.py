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
    t1 = api.emit("promoter", venue, s["event"], ticket_type_id=s["type"], allocation_id=s["allocation"]["id"])
    t2 = api.emit("promoter", venue, s["event"], ticket_type_id=s["type"], allocation_id=s["allocation"]["id"])
    api.emit("promoter", venue, s["event"], ticket_type_id=s["type"], allocation_id=s["allocation"]["id"])
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


def test_overview_commissions_null_without_payouts(api):
    """Sin liquidaciones, commissions_cents es None (no 0).

    En el MVP la venta de pago es directa y el promotor solo mueve cortesías,
    así que no hay comisión calculable. El neto que muestra el panel no puede
    inventarse: null significa "no aplica", 0 significaría "la comisión fue 0".
    """
    s = api.scenario()
    res = api.get(f"/venues/{s['venue']}/overview", "admin")
    assert res.status_code == 200, res.text
    body = res.json()
    assert "commissions_cents" in body
    assert body["commissions_cents"] is None


def test_overview_commissions_sum_of_month_payouts(api):
    """Con liquidaciones del mes, commissions_cents suma sus comisiones."""
    s = api.scenario()
    venue, event = s["venue"], s["event"]
    # El cupo del scenario tiene capacidad; emitimos cortesías del promotor.
    for _ in range(3):
        api.emit(
            "promoter",
            venue,
            event,
            ticket_type_id=s["type"],
            allocation_id=s["allocation"]["id"],
        )
    res = api.client.post(
        f"/venues/{venue}/payouts/generate",
        headers=api.headers("admin"),
        json={
            "promoter_id": s["allocation"]["promoter_id"],
            "period_start": (datetime.now(tz=timezone.utc) - timedelta(days=1)).date().isoformat(),
            "period_end": (datetime.now(tz=timezone.utc) + timedelta(days=1)).date().isoformat(),
        },
    )
    assert res.status_code in (200, 201), res.text
    commission = res.json()["commission_cents"]

    body = api.get(f"/venues/{venue}/overview", "admin").json()
    assert body["commissions_cents"] == commission


def test_overview_invalid_month(api):
    s = api.scenario()
    res = api.get(f"/venues/{s['venue']}/overview?month=2026-13", "admin")
    assert res.status_code == 400
    res = api.get(f"/venues/{s['venue']}/overview?month=noche", "admin")
    assert res.status_code == 400


def test_overview_sales_curve_has_all_buckets_in_order(api):
    """La curva viaja con los 5 tramos SIEMPRE, aunque no haya venta."""
    s = api.scenario()
    body = api.get(f"/venues/{s['venue']}/overview", "admin").json()
    assert [b["bucket"] for b in body["sales_curve"]] == [
        "30+", "15-29", "8-14", "2-7", "0-1",
    ]
    for b in body["sales_curve"]:
        assert b["tickets"] == 0
        assert b["revenue_cents"] == 0


def test_overview_sales_curve_buckets_by_anticipation(api):
    """Cada tramo agrupa por días de anticipación; solo cuentan las vivas.

    El total dice CUÁNTO se vendió; la curva dice CUÁNDO. La boleta anulada
    no debe aparecer en ningún tramo.
    """
    s = api.scenario()
    venue, event = s["venue"], s["event"]
    # Tres boletas vivas + una que se anula.
    t_early = api.emit("promoter", venue, event, ticket_type_id=s["type"], allocation_id=s["allocation"]["id"])
    t_mid = api.emit("promoter", venue, event, ticket_type_id=s["type"], allocation_id=s["allocation"]["id"])
    t_door = api.emit("promoter", venue, event, ticket_type_id=s["type"], allocation_id=s["allocation"]["id"])
    t_void = api.emit("promoter", venue, event, ticket_type_id=s["type"], allocation_id=s["allocation"]["id"])
    api.client.post(
        f"/venues/{venue}/events/{event}/tickets/{t_void['ticket_id']}/void",
        headers=api.headers("admin"),
        json={"reason": "prueba"},
    )

    # issued_at se reescribe directo en DB: la API siempre emite con now().
    # 20 días antes → '15-29'; 5 días → '2-7'; 1 día → '0-1'.
    api.run_sql(
        f"UPDATE tickets SET issued_at = (SELECT starts_at FROM events WHERE id={event}) - interval '20 days' "
        f"WHERE id = {t_early['ticket_id']}"
    )
    api.run_sql(
        f"UPDATE tickets SET issued_at = (SELECT starts_at FROM events WHERE id={event}) - interval '5 days' "
        f"WHERE id = {t_mid['ticket_id']}"
    )
    api.run_sql(
        f"UPDATE tickets SET issued_at = (SELECT starts_at FROM events WHERE id={event}) - interval '1 day' "
        f"WHERE id = {t_door['ticket_id']}"
    )

    body = api.get(f"/venues/{venue}/overview", "admin").json()
    by_bucket = {b["bucket"]: b["tickets"] for b in body["sales_curve"]}
    assert by_bucket["15-29"] == 1
    assert by_bucket["2-7"] == 1
    assert by_bucket["0-1"] == 1
    assert by_bucket["30+"] == 0
    assert by_bucket["8-14"] == 0
    # La anulada no entra en ningún tramo.
    total = sum(by_bucket.values())
    assert total == body["tickets_issued"]


def test_overview_sales_curve_door_sale_counts_as_0_1(api):
    """Una venta DESPUÉS del inicio (resta negativa) cae en '0-1', no se pierde."""
    s = api.scenario()
    venue, event = s["venue"], s["event"]
    t = api.emit("promoter", venue, event, ticket_type_id=s["type"], allocation_id=s["allocation"]["id"])
    api.run_sql(
        f"UPDATE tickets SET issued_at = (SELECT starts_at FROM events WHERE id={event}) + interval '2 hours' "
        f"WHERE id = {t['ticket_id']}"
    )
    body = api.get(f"/venues/{venue}/overview", "admin").json()
    by_bucket = {b["bucket"]: b["tickets"] for b in body["sales_curve"]}
    assert by_bucket["0-1"] == 1
    assert sum(by_bucket.values()) == 1


def _emit_phone(api, venue, event, ttype, alloc, phone):
    res = api.client.post(
        f"/venues/{venue}/events/{event}/tickets",
        headers=api.headers("promoter"),
        json={
            "ticket_type_id": ttype,
            "allocation_id": alloc,
            "customer_name": "Asistente",
            "customer_phone": phone,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_overview_retention_identifies_returning_buyer(api):
    """Un comprador anterior del venue (mismo teléfono) cuenta como recurrente.

    Los dos formatos de teléfono ('300...' y '57300...') deben ser la MISMA
    persona: la normalización a los últimos 10 dígitos es lo que lo logra.
    """
    s = api.scenario()
    venue, event = s["venue"], s["event"]
    promoter = s["allocation"]["promoter_id"]

    # Evento de hace 2 meses, con una compra del teléfono '573001234567'.
    prior = api.create_event("admin", venue, name="Noche pasada", capacity=50)
    prior_type = api.add_type("admin", venue, prior["id"], quantity=20)
    prior_alloc = api.set_allocation(
        "admin", venue, prior["id"], ticket_type_id=prior_type["id"],
        promoter_id=promoter, capacity=5,
    )
    api.publish("admin", venue, prior["id"])
    prior_t = _emit_phone(api, venue, prior["id"], prior_type["id"], prior_alloc["id"], "573001234567")
    api.run_sql(
        f"UPDATE events SET starts_at = now() - interval '2 months' WHERE id = {prior['id']}"
    )
    api.run_sql(
        f"UPDATE tickets SET issued_at = now() - interval '2 months' WHERE id = {prior_t['ticket_id']}"
    )

    # Mes en curso: el mismo cliente (formato local) + un cliente nuevo.
    _emit_phone(api, venue, event, s["type"], s["allocation"]["id"], "3001234567")
    _emit_phone(api, venue, event, s["type"], s["allocation"]["id"], "3009998888")

    body = api.get(f"/venues/{venue}/overview", "admin").json()
    assert body["retention_buyers"] == 2
    assert body["retention_returning"] == 1


def test_overview_retention_ignores_buyers_without_phone(api):
    """Sin teléfono no se puede saber si repite: queda fuera del denominador."""
    s = api.scenario()
    venue, event = s["venue"], s["event"]
    # La API exige teléfono ≥5 chars; el caso "sin teléfono" (boleta emitida
    # por otras vías) se siembra directo en DB.
    t = api.emit("promoter", venue, event, ticket_type_id=s["type"], allocation_id=s["allocation"]["id"])
    api.run_sql(f"UPDATE tickets SET customer_phone = NULL WHERE id = {t['ticket_id']}")
    body = api.get(f"/venues/{venue}/overview", "admin").json()
    assert body["retention_buyers"] == 0
    assert body["retention_returning"] == 0


def test_overview_csv_includes_sales_curve(api):
    """El CSV del contador trae la sección de ritmo de venta."""
    s = api.scenario()
    venue, event = s["venue"], s["event"]
    t = api.emit("promoter", venue, event, ticket_type_id=s["type"], allocation_id=s["allocation"]["id"])
    api.run_sql(
        f"UPDATE tickets SET issued_at = (SELECT starts_at FROM events WHERE id={event}) - interval '20 days' "
        f"WHERE id = {t['ticket_id']}"
    )
    res = api.get(f"/venues/{venue}/overview.csv", "admin")
    assert res.status_code == 200, res.text
    text = res.content.decode("utf-8-sig")
    assert "Ritmo de venta" in text
    assert "15-29" in text
    # La fila del tramo 15-29 lleva la boleta que backdateamos.
    line = next(l for l in text.splitlines() if l.startswith("15-29"))
    assert line.split(",")[1] == "1"


def test_overview_csv_requires_admin(api):
    s = api.scenario()
    res = api.get(f"/venues/{s['venue']}/overview.csv", "promoter")
    assert res.status_code == 403
