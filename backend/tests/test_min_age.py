"""Edad minima del evento (mig 051): de adorno a barrera real.

Antes de esta migracion `events.min_age` solo se mostraba en la ficha publica
("Edad minima: 18+"): no habia captura de fecha de nacimiento ni validacion en
ningun punto. Una prueba con 20 personas de 8 a 78 anos lo confirmo — un nino
de 8 anos entro sin problema a un evento "21+".

Estos tests cubren las tres puertas donde la restriccion debe morder:
  * la compra online (antes de cobrar),
  * la emision de taquilla (venta directa del staff),
  * la puerta (defensa en profundidad al canjear el QR).

La regla es "cumple los anos ANTES o EL DIA del evento": se compara contra la
fecha de inicio del evento, no contra hoy, para que quien cumple justo el dia
de la fiesta pueda entrar. Sin fecha de nacimiento no hay nada que verificar
(venta a ciegas en la puerta): se permite, como antes.
"""

import uuid
from datetime import date, datetime, timedelta, timezone


# ---------------------------------------------------------------------------
# Venta directa (panel del staff)
# ---------------------------------------------------------------------------
def _emit(api, scen, *, birth_date, name="Asistente"):
    return api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets",
        "admin",
        {
            "ticket_type_id": scen["type"],
            "customer_name": name,
            "customer_phone": "573001112233",
            "customer_birth_date": birth_date,
        },
    )


def _scenario_min_age(api, min_age: int) -> dict:
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Edad {uuid.uuid4().hex[:6]}",
                          min_age=min_age)
    t = api.add_type("admin", venue, ev["id"], name="General",
                     price_cents=30000, quantity=50, is_courtesy=False)
    api.publish("admin", venue, ev["id"])
    return {"venue": venue, "event": ev["id"], "type": t["id"],
            "starts_at": ev["starts_at"]}


def _years_before(reference: str, years: int, *, days: int = 0) -> str:
    """Fecha de nacimiento que deja a la persona con `years` anos el dia del
    evento (resta exacta de anos). `days` mueve la fecha de nacimiento hacia
    ADELANTE (>0 = mas joven) para probar la frontera."""
    ref = datetime.fromisoformat(reference).date()
    try:
        base = ref.replace(year=ref.year - years)
    except ValueError:  # 29 de febrero
        base = ref.replace(year=ref.year - years, day=28)
    return (base + timedelta(days=days)).isoformat()


def test_emit_rejects_under_age(api):
    """Un menor de la edad minima no puede comprar ni en taquilla."""
    scen = _scenario_min_age(api, min_age=18)
    res = _emit(api, scen, birth_date=_years_before(scen["starts_at"], 10))
    assert res.status_code == 403, res.text
    assert "edad" in res.json()["detail"].lower()


def test_emit_allows_of_age(api):
    """Alguien que ya cumplio la edad minima si puede."""
    scen = _scenario_min_age(api, min_age=18)
    res = _emit(api, scen, birth_date=_years_before(scen["starts_at"], 30))
    assert res.status_code == 201, res.text


def test_emit_allows_turning_age_on_event_day(api):
    """La regla es la fecha del EVENTO: quien cumple ese mismo dia entra."""
    scen = _scenario_min_age(api, min_age=18)
    res = _emit(api, scen, birth_date=_years_before(scen["starts_at"], 18))
    assert res.status_code == 201, res.text
    # Un dia despues de la fiesta todavia no los cumplia -> rechazado.
    res2 = _emit(api, scen, birth_date=_years_before(scen["starts_at"], 18, days=1))
    assert res2.status_code == 403, res2.text


def test_emit_without_birth_date_is_allowed(api):
    """Sin fecha de nacimiento no hay nada que verificar: la venta sigue
    (comportamiento anterior a la migracion; no se puede romper la taquilla)."""
    scen = _scenario_min_age(api, min_age=18)
    res = _emit(api, scen, birth_date=None)
    assert res.status_code == 201, res.text


def test_emit_without_restriction_ignores_birth_date(api):
    """Un evento sin edad minima no rechaza a nadie por su fecha."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Libre {uuid.uuid4().hex[:6]}")
    t = api.add_type("admin", venue, ev["id"], price_cents=30000, quantity=50,
                     is_courtesy=False)
    api.publish("admin", venue, ev["id"])
    scen = {"venue": venue, "event": ev["id"], "type": t["id"]}
    res = _emit(api, scen, birth_date=_years_before(
        datetime.now(timezone.utc).isoformat(), 5))
    assert res.status_code == 201, res.text


def test_birth_date_is_persisted_on_ticket(api, dbcur):
    """La fecha declarada queda en la boleta: es la evidencia para la puerta."""
    scen = _scenario_min_age(api, min_age=18)
    birth = _years_before(scen["starts_at"], 30)
    res = _emit(api, scen, birth_date=birth)
    assert res.status_code == 201, res.text
    raw = res.json()["raw_token"]
    dbcur.execute(
        "SELECT customer_birth_date FROM tickets "
        "WHERE token_hash = encode(digest(%s,'sha256'),'hex')",
        (raw,),
    )
    assert dbcur.fetchone()["customer_birth_date"] == date.fromisoformat(birth)


# ---------------------------------------------------------------------------
# Puerta (defensa en profundidad)
# ---------------------------------------------------------------------------
def _open_doors(api, venue: int, event_id: int) -> None:
    import os

    import psycopg

    res = api.post(f"/venues/{venue}/events/{event_id}/live", "admin")
    assert res.status_code == 200, res.text
    dsn = os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
    )
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            "UPDATE events SET starts_at = now() - interval '1 hour' WHERE id = %s",
            (event_id,),
        )


def _emit_direct(dbcur, event_id, type_id, token, name, birth_date):
    from datetime import date as _date

    dbcur.execute(
        "SELECT emit_ticket(%s,%s,NULL,NULL,%s,%s,NULL,NULL,NULL,%s)",
        (event_id, type_id, name, token, _date.fromisoformat(birth_date)),
    )


def test_door_rejects_under_age_ticket(api, dbcur):
    """Una boleta con fecha menor a la edad minima no entra por la puerta.

    Simula la boleta emitida ANTES de activar la restriccion (o con la fecha
    cambiada despues): la barrera de la puerta la detiene igual.
    """
    scen = api.scenario()
    v, e, tt = scen["venue"], scen["event"], scen["type"]
    # Se emite SIN restriccion (como existiria antes de la mig 051)...
    _emit_direct(dbcur, e, tt, "tok-menor-puerta-01", "Menor", "2015-01-01")
    # ...y despues se activa la edad minima del evento.
    dbcur.execute("UPDATE events SET min_age = 18 WHERE id = %s", (e,))
    _open_doors(api, v, e)

    res = api.post(
        f"/venues/{v}/events/{e}/redeem", "bouncer",
        {"raw_token": "tok-menor-puerta-01"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["code"] == "UNDER_AGE", body
    assert body["redeemed"] is False
    # La boleta NO se consumio: el rechazo no quema el QR.
    status = api.run_sql(
        "SELECT status FROM tickets "
        "WHERE token_hash = encode(digest('tok-menor-puerta-01','sha256'),'hex')"
    )
    assert status == "issued"


def test_door_allows_of_age_ticket(api, dbcur):
    """La misma puerta deja entrar a quien si cumple la edad."""
    scen = api.scenario()
    v, e, tt = scen["venue"], scen["event"], scen["type"]
    _emit_direct(dbcur, e, tt, "tok-adulto-puerta-01", "Adulto", "1990-05-05")
    dbcur.execute("UPDATE events SET min_age = 18 WHERE id = %s", (e,))
    _open_doors(api, v, e)

    res = api.post(
        f"/venues/{v}/events/{e}/redeem", "bouncer",
        {"raw_token": "tok-adulto-puerta-01"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["code"] == "GRANTED"


# ---------------------------------------------------------------------------
# Compra online (antes de cobrar)
# ---------------------------------------------------------------------------
def _mock_wompi(monkeypatch):
    import app.core.config as config_mod
    from app.routers import public as public_mod

    settings = config_mod.get_settings()
    monkeypatch.setattr(settings, "wompi_private_key", "prv_test_x", raising=False)
    monkeypatch.setattr(settings, "wompi_events_secret", "test_events_y",
                        raising=False)

    async def fake_create_payment_link(**kwargs):
        return {"id": f"link-{uuid.uuid4().hex[:12]}", "slug": "x"}

    monkeypatch.setattr(public_mod.wompi, "create_payment_link",
                        fake_create_payment_link)


def _checkout(api, event_id, type_id, *, birth_date=None, name="Fan"):
    payload = {
        "ticket_type_id": type_id,
        "customer_name": name,
        "customer_phone": "573001112233",
        "customer_email": "fan@example.test",
    }
    if birth_date is not None:
        payload["customer_birth_date"] = birth_date
    return api.client.post(f"/public/events/{event_id}/checkout", json=payload)


def test_checkout_rejects_under_age_before_charging(api, monkeypatch):
    """Se rechaza al menor ANTES de crear el cobro: nunca llega a pagar."""
    _mock_wompi(monkeypatch)
    scen = _scenario_min_age(api, min_age=21)
    res = _checkout(api, scen["event"], scen["type"],
                    birth_date=_years_before(scen["starts_at"], 15))
    assert res.status_code == 403, res.text
    assert "edad" in res.json()["detail"].lower()
    # No quedo ningun cobro pendiente colgado por el rechazo.
    pagos = api.run_sql(
        f"SELECT count(*) FROM ticket_payments WHERE event_id = {scen['event']}"
    )
    assert pagos == 0


def test_checkout_allows_of_age(api, monkeypatch):
    """Un adulto compra normal: la validacion no estorba al flujo feliz."""
    _mock_wompi(monkeypatch)
    scen = _scenario_min_age(api, min_age=18)
    res = _checkout(api, scen["event"], scen["type"],
                    birth_date=_years_before(scen["starts_at"], 25))
    assert res.status_code == 201, res.text
    # La fecha declarada viaja con el cobro para que la emision la use.
    ref = res.json()["reference"]
    stored = api.run_sql(
        f"SELECT customer_birth_date FROM ticket_payments WHERE reference = '{ref}'"
    )
    assert stored == date.fromisoformat(_years_before(scen["starts_at"], 25))
