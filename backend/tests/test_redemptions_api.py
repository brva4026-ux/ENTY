"""Detalle y export del registro de puerta (redemptions).

`/summary` ya daba CONTEOS; lo que faltaba era el detalle fila por fila:
quien escaneo, a que hora, que boleta dio duplicada. Ese registro es la
evidencia cuando hay una discusion con un portero o un promotor.
"""
import pytest


def _open_doors(api, venue: int, event_id: int) -> None:
    """published -> live y arranca el evento: la ventana del QR ya abrio.

    El escaneo sucede el dia del evento; los tests existentes usan el mismo
    patron (test_api_noshow_and_type_filter._open_doors). Con UPDATE directo
    (api.run_sql solo acepta SELECT escalares).
    """
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


def _emit(dbcur, event_id: int, type_id: int, token: str, name: str) -> None:
    dbcur.execute(
        "SELECT emit_ticket(%s, %s, NULL, NULL, %s, %s, NULL, NULL)",
        (event_id, type_id, name, token),
    )


def _scan(api, venue_id: int, event_id: int, token: str):
    return api.post(
        f"/venues/{venue_id}/events/{event_id}/redeem", "bouncer",
        {"raw_token": token},
    )


def test_redemptions_admin_only(api):
    """El detalle de la puerta es material de caja: solo staff de admin."""
    scen = api.scenario()
    url = f"/venues/{scen['venue']}/events/{scen['event']}/redemptions"
    assert api.get(url, "promoter").status_code == 403
    assert api.get(url, "bouncer").status_code == 403
    assert api.get(url, "outsider").status_code == 403
    assert api.get(url, "admin").status_code == 200


def test_redemptions_detail_records_every_attempt(api, dbcur):
    """Dos escaneos del mismo token: entrada + duplicado, con quien y cuando."""
    scen = api.scenario()
    v, e, tt = scen["venue"], scen["event"], scen["type"]
    _open_doors(api, v, e)
    _emit(dbcur, e, tt, "tok-detalle-duplicado-01", "Ana Duplicada")
    assert _scan(api, v, e, "tok-detalle-duplicado-01").json()["code"] == "GRANTED"
    assert (
        _scan(api, v, e, "tok-detalle-duplicado-01").json()["code"]
        == "ALREADY_REDEEMED"
    )

    res = api.get(f"/venues/{v}/events/{e}/redemptions", "admin")
    assert res.status_code == 200, res.text
    d = res.json()
    assert d["total"] == 2
    assert [i["outcome"] for i in d["items"]] == ["already_redeemed", "granted"]
    primero = d["items"][0]
    assert primero["customer_name"] == "Ana Duplicada"
    assert primero["scanned_by"], "debe decir que portero escaneo"
    assert "token" not in str(d).lower(), "nunca exponer tokens ni hashes"


def test_redemptions_filters(api, dbcur):
    """Filtro por resultado y busqueda por invitado."""
    scen = api.scenario()
    v, e, tt = scen["venue"], scen["event"], scen["type"]
    _open_doors(api, v, e)
    _emit(dbcur, e, tt, "tok-filtro-ok-0001", "Bea Entrada")
    _emit(dbcur, e, tt, "tok-filtro-dup-01", "Camila Duplicada")
    _scan(api, v, e, "tok-filtro-ok-0001")
    _scan(api, v, e, "tok-filtro-dup-01")
    _scan(api, v, e, "tok-filtro-dup-01")

    url = f"/venues/{v}/events/{e}/redemptions"
    dup = api.get(f"{url}?outcome=already_redeemed", "admin").json()
    assert dup["total"] == 1
    assert dup["items"][0]["customer_name"] == "Camila Duplicada"

    por_nombre = api.get(f"{url}?q=Camila", "admin").json()
    assert por_nombre["total"] == 2

    rango = api.get(f"{url}?since=2100-01-01T00:00:00Z", "admin").json()
    assert rango["total"] == 0

    assert api.get(f"{url}?outcome=inventado", "admin").status_code == 422


def test_redemptions_csv_export(api, dbcur):
    """El CSV trae TODO lo filtrado, traducido y audita la descarga."""
    scen = api.scenario()
    v, e, tt = scen["venue"], scen["event"], scen["type"]
    _open_doors(api, v, e)
    _emit(dbcur, e, tt, "tok-csv-entrada-001", "Diana Puerta")
    _scan(api, v, e, "tok-csv-entrada-001")
    _scan(api, v, e, "tok-que-no-existe-99")

    url = f"/venues/{v}/events/{e}/redemptions.csv?outcome=not_found"
    res = api.get(url, "admin")
    assert res.status_code == 200
    assert "text/csv" in res.headers["content-type"]
    assert "attachment" in res.headers["content-disposition"]
    assert "QR DESCONOCIDO" in res.text

    todo = api.get(f"/venues/{v}/events/{e}/redemptions.csv", "admin")
    assert "ENTRADA" in todo.text
    assert "Diana Puerta" in todo.text
    assert "tok-csv-entrada-001" not in todo.text, "el token crudo no viaja"

    dbcur.execute(
        "SELECT count(*)::int AS n FROM audit_log WHERE kind='redemptions_export'"
    )
    assert dbcur.fetchone()["n"] >= 1, "la descarga debe quedar auditada"


def test_redemptions_csv_admin_only(api):
    scen = api.scenario()
    url = f"/venues/{scen['venue']}/events/{scen['event']}/redemptions.csv"
    assert api.get(url, "bouncer").status_code == 403
    assert api.get(url, "promoter").status_code == 403


def test_redemptions_404_evento_ajeno(api):
    """Un evento de otra venue no se lista ni con rol admin en la propia.

    El guard de roles (403) corre antes que el lookup del evento (404):
    cualquiera de las dos respuestas es correcta mientras no haya datos.
    """
    scen = api.scenario()
    url = f"/venues/{api.world['venue_b']}/events/{scen['event']}/redemptions"
    assert api.get(url, "admin").status_code in (403, 404)
