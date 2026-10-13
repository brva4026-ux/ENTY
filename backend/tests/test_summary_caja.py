"""Caja con rango de fechas (`/summary?since&until` y `/summary.csv`).

El registro de puerta ya cerraba por periodo; la CAJA no: `/summary` era
siempre "ahora". Estos tests fijan el mismo contrato semiabierto [since,
until) sobre la caja: emitir una boleta vieja la deja fuera de la ventana, y
el CSV respeta el mismo corte.
"""
from datetime import datetime, timedelta, timezone

import psycopg


def _iso(dt: datetime) -> str:
    """ISO 8601 con `Z`: un `+00:00` en el query se lee como espacio."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _published_event(api, name: str, price_cents: int) -> tuple[int, int, dict]:
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=name)
    tipo = api.add_type(
        "admin", venue, ev["id"],
        name="Pago", price_cents=price_cents, quantity=50, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    return venue, ev["id"], tipo


def _emit(api, venue: int, event_id: int, type_id: int, name: str) -> dict:
    return api.emit(
        "admin", venue, event_id, ticket_type_id=type_id, allocation_id=None,
        customer_name=name,
    )


def _age_ticket(api, ticket_id: int, days: int) -> None:
    """Mueve issued_at N dias atras (la API no expone esta columna)."""
    with psycopg.connect(api.dsn, autocommit=True) as conn:
        conn.execute(
            "UPDATE tickets SET issued_at = now() - %s::interval WHERE id = %s",
            (f"{days} days", ticket_id),
        )


def test_summary_window_acota_caja(api):
    """Sin rango = todo el evento; con since/until solo la ventana."""
    venue, event_id, tipo = _published_event(api, "Caja por rango", 30000)
    vieja = _emit(api, venue, event_id, tipo["id"], "Vieja")
    nueva = _emit(api, venue, event_id, tipo["id"], "Nueva")
    _age_ticket(api, vieja["ticket_id"], days=10)

    url = f"/venues/{venue}/events/{event_id}/summary"

    todo = api.get(url, "admin").json()
    assert todo["issued"] == 2
    assert todo["revenue_cents"] == 60000
    assert todo["since"] is None and todo["until"] is None

    # Corte de los ultimos 5 dias: la boleta vieja (10 dias) queda fuera.
    desde = _iso(datetime.now(timezone.utc) - timedelta(days=5))
    reciente = api.get(f"{url}?since={desde}", "admin").json()
    assert reciente["issued"] == 1
    assert reciente["revenue_cents"] == 30000

    # Corte al reves: hasta hace 5 dias -> solo la vieja.
    hasta = _iso(datetime.now(timezone.utc) - timedelta(days=5))
    antigua = api.get(f"{url}?until={hasta}", "admin").json()
    assert antigua["issued"] == 1
    assert antigua["revenue_cents"] == 30000

    # La ventana viaja en la respuesta para que la UI la rotule.
    assert reciente["since"] is not None
    assert reciente["until"] is None
    assert antigua["until"] is not None


def test_summary_csv_respeta_rango(api):
    """El CSV de caja usa el mismo corte: la boleta vieja no aparece."""
    venue, event_id, tipo = _published_event(api, "Caja CSV", 25000)
    vieja = _emit(api, venue, event_id, tipo["id"], "Vieja")
    _emit(api, venue, event_id, tipo["id"], "Nueva")
    _age_ticket(api, vieja["ticket_id"], days=10)

    desde = _iso(datetime.now(timezone.utc) - timedelta(days=5))
    res = api.get(
        f"/venues/{venue}/events/{event_id}/summary.csv?since={desde}", "admin"
    )
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/csv")

    lines = [ln for ln in res.text.splitlines() if ln.strip()]
    assert any("Cierre de caja" in ln for ln in lines)
    # Recaudo del periodo = 1 boleta paga de 25000c -> 250.0 COP.
    assert "Recaudo (COP),250.0" in res.text
    assert "Boletas vivas,1" in res.text
    # El rango pedido queda escrito en el archivo.
    assert any("Periodo" in ln for ln in lines)


def test_summary_rango_invalido_es_422(api):
    """until anterior a since es un error de la peticion, no un vacio."""
    venue, event_id, _ = _published_event(api, "Caja invalida", 10000)
    desde = _iso(datetime.now(timezone.utc))
    hasta = _iso(datetime.now(timezone.utc) - timedelta(days=1))
    res = api.get(
        f"/venues/{venue}/events/{event_id}/summary?since={desde}&until={hasta}",
        "admin",
    )
    assert res.status_code == 422, res.text


def test_summary_since_fecha_sin_hora(api):
    """Una fecha suelta ("2020-01-01") es un piso valido, sin explotar."""
    venue, event_id, tipo = _published_event(api, "Caja naive", 10000)
    _emit(api, venue, event_id, tipo["id"], "Hoy")
    url = f"/venues/{venue}/events/{event_id}/summary"
    incluye = api.get(f"{url}?since=2020-01-01", "admin").json()
    assert incluye["issued"] == 1
    excluye = api.get(f"{url}?since=2999-01-01", "admin").json()
    assert excluye["issued"] == 0


def test_summary_window_acota_puerta(api):
    """La integridad de puerta tambien se acota a la ventana pedida."""
    venue, event_id, tipo = _published_event(api, "Caja puerta", 0)
    t = _emit(api, venue, event_id, tipo["id"], "Asistente")

    # published -> live y el QR ya esta activo (starts_at al pasado).
    api.post(f"/venues/{venue}/events/{event_id}/live", "admin")
    with psycopg.connect(api.dsn, autocommit=True) as conn:
        conn.execute(
            "UPDATE events SET starts_at = now() - interval '1 hour' WHERE id = %s",
            (event_id,),
        )
    api.post(
        f"/venues/{venue}/events/{event_id}/redeem", "bouncer",
        {"raw_token": t["raw_token"]},
    )

    url = f"/venues/{venue}/events/{event_id}/summary"
    todo = api.get(url, "admin").json()
    assert todo["door"]["granted"] == 1

    # El scan fue "ahora": una ventana que arranca en el futuro lo excluye.
    futuro = _iso(datetime.now(timezone.utc) + timedelta(days=1))
    sin_ventana = api.get(f"{url}?since={futuro}", "admin").json()
    assert sin_ventana["door"]["granted"] == 0
    assert sin_ventana["door"]["total"] == 0

    # Y una que arranca ayer lo incluye.
    ayer = _iso(datetime.now(timezone.utc) - timedelta(days=1))
    con_ventana = api.get(f"{url}?since={ayer}", "admin").json()
    assert con_ventana["door"]["granted"] == 1
