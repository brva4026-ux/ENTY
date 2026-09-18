"""Tests v1.1: CSV de no-shows y filtro de tipo de boleta en la puerta.

No-show = boleta ACTIVA (issued) que nunca se redimió y tiene datos de
contacto: la lista de re-marketing tras el evento.

Filtro de fila (mig 008): redeem_ticket acepta un tipo esperado; una boleta
válida del evento pero de OTRO tipo se rechaza con code=WRONG_TYPE SIN
consumirla (puede entrar por la fila correcta después). El intento queda
auditado en redemptions con outcome 'wrong_type'.
"""
from datetime import datetime, timedelta, timezone


def _future_offset() -> str:
    return (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()


def _live_offset() -> str:
    """Evento que abre puertas hace 1 hora (para escanear en vivo)."""
    return (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()


def _open_doors(api, venue: int, event_id: int) -> None:
    """published -> live (la puerta solo acepta escaneos así)."""
    res = api.post(f"/venues/{venue}/events/{event_id}/live", "admin")
    assert res.status_code == 200, res.text


# ===========================================================================
# CSV de no-shows
# ===========================================================================

def _emit_direct(api, venue: int, event_id: int, type_id: int, name: str, **extra) -> dict:
    payload = {
        "ticket_type_id": type_id,
        "customer_name": name,
        "customer_phone": "3001234567",
        **extra,
    }
    res = api.post(f"/venues/{venue}/events/{event_id}/tickets", "admin", payload)
    assert res.status_code == 201, res.text
    return res.json()


def _parse_csv(content: str) -> list[list[str]]:
    """Parser mínimo: respeta comillas dobles del csv.writer (sin BOM)."""
    import csv
    import io

    # utf-8-sig consume el BOM si existe (csv.writer + _csv_response).
    text = content.encode("utf-8").decode("utf-8-sig")
    return list(csv.reader(io.StringIO(text)))


def test_noshow_csv_lists_active_unredeemed_with_contact(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Noshow Event", starts_at=_future_offset())
    t = api.add_type("admin", venue, ev["id"], name="Cortesia", quantity=20)
    # El emisor exige evento publicado (draft no vende).
    api.publish("admin", venue, ev["id"])

    # 3 boletas activas con contacto (el teléfono es obligatorio en la API;
    # el email es complemento opcional para el re-marketing).
    _emit_direct(api, venue, ev["id"], t["id"], "Con Telefono")
    _emit_direct(api, venue, ev["id"], t["id"], "Con Email", customer_email="a@x.dev")
    _emit_direct(api, venue, ev["id"], t["id"], "Ambos", customer_email="b@x.dev")

    res = api.get(f"/venues/{venue}/events/{ev['id']}/noshow.csv", "admin")
    assert res.status_code == 200, res.text
    assert "text/csv" in res.headers["content-type"]

    rows = _parse_csv(res.text)
    assert rows[0] == ["Nombre", "Telefono", "Email", "Tipo", "Emitida por", "Fecha emision"]
    names = [r[0] for r in rows[1:]]
    assert names == ["Con Telefono", "Con Email", "Ambos"]
    assert rows[1][1] == "3001234567"  # teléfono
    assert rows[1][2] == ""  # sin email
    assert rows[2][2] == "a@x.dev"  # email presente


def test_noshow_csv_excludes_redeemed_and_voided(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Noshow Mix", starts_at=_future_offset())
    t = api.add_type("admin", venue, ev["id"], name="General", quantity=20)
    api.publish("admin", venue, ev["id"])

    entered = _emit_direct(api, venue, ev["id"], t["id"], "Ya Entro")
    voided = _emit_direct(api, venue, ev["id"], t["id"], "Anulada")
    _emit_direct(api, venue, ev["id"], t["id"], "No Fue")

    # Anular la segunda por la vía de la app.
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/tickets/{voided['ticket_id']}/void",
        "admin",
        {"reason": "error de digitación"},
    )
    assert res.status_code == 200, res.text

    # Abrir puertas y redimir a la primera.
    _open_doors(api, venue, ev["id"])
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/redeem",
        "bouncer",
        {"raw_token": entered["raw_token"]},
    )
    assert res.status_code == 200 and res.json()["redeemed"], res.text

    res = api.get(f"/venues/{venue}/events/{ev['id']}/noshow.csv", "admin")
    rows = _parse_csv(res.text)
    names = [r[0] for r in rows[1:]]
    assert names == ["No Fue"]  # ni el canjeado ni el anulado


def test_noshow_csv_permission_promoter_forbidden(api):
    """El CSV es herramienta del organizador: el promotor no lo descarga."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Noshow Perm", starts_at=_future_offset())
    res = api.get(f"/venues/{venue}/events/{ev['id']}/noshow.csv", "promoter")
    assert res.status_code == 403


# ===========================================================================
# Filtro de tipo de boleta en la puerta (mig 008)
# ===========================================================================

def _setup_two_rows(api) -> dict:
    """Evento EN VIVO con dos tipos y una boleta de cada uno."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Dos Filas", starts_at=_live_offset())
    t_vip = api.add_type("admin", venue, ev["id"], name="VIP", quantity=10)
    t_gen = api.add_type("admin", venue, ev["id"], name="General", quantity=50)
    api.publish("admin", venue, ev["id"])
    _open_doors(api, venue, ev["id"])
    vip = _emit_direct(api, venue, ev["id"], t_vip["id"], "Sra VIP")
    gen = _emit_direct(api, venue, ev["id"], t_gen["id"], "Sr General")
    return {"venue": venue, "event": ev["id"], "vip": t_vip["id"], "gen": t_gen["id"],
            "vip_token": vip["raw_token"], "gen_token": gen["raw_token"]}


def test_redeem_without_filter_accepts_any_type(api):
    s = _setup_two_rows(api)
    url = f"/venues/{s['venue']}/events/{s['event']}/redeem"
    # Sin filtro (comportamiento clásico): todo tipo entra.
    res = api.post(url, "bouncer", {"raw_token": s["gen_token"]})
    assert res.status_code == 200 and res.json()["code"] == "GRANTED", res.text


def test_redeem_with_filter_accepts_matching_type(api):
    s = _setup_two_rows(api)
    url = f"/venues/{s['venue']}/events/{s['event']}/redeem"
    res = api.post(url, "bouncer", {"raw_token": s["vip_token"], "ticket_type_id": s["vip"]})
    body = res.json()
    assert res.status_code == 200 and body["code"] == "GRANTED", res.text
    assert body["customer_name"] == "Sra VIP"


def test_redeem_with_filter_rejects_other_type_without_consuming(api):
    s = _setup_two_rows(api)
    url = f"/venues/{s['venue']}/events/{s['event']}/redeem"
    # La boleta de General se presenta en la fila VIP...
    res = api.post(url, "bouncer", {"raw_token": s["gen_token"], "ticket_type_id": s["vip"]})
    body = res.json()
    assert res.status_code == 200, res.text
    assert body["code"] == "WRONG_TYPE"
    assert body["redeemed"] is False
    assert body["detail"] == "Boleta de General"

    # ...y NO se consumió: en la fila correcta entra sin problemas.
    res = api.post(url, "bouncer", {"raw_token": s["gen_token"], "ticket_type_id": s["gen"]})
    assert res.json()["code"] == "GRANTED", res.text


def test_redeem_wrong_type_is_audited(api, db):
    s = _setup_two_rows(api)
    url = f"/venues/{s['venue']}/events/{s['event']}/redeem"
    api.post(url, "bouncer", {"raw_token": s["gen_token"], "ticket_type_id": s["vip"]})
    row = db.execute(
        "SELECT outcome FROM redemptions WHERE event_id=%s ORDER BY id DESC LIMIT 1",
        (s["event"],),
    ).fetchone()
    assert row["outcome"] == "wrong_type"


def test_redeem_filter_door_closed_wins_over_wrong_type(api):
    """Puerta cerrada manda: el estado accionable es el de la puerta."""
    s = _setup_two_rows(api)
    # Cerrar puertas (live -> ended).
    res = api.post(f"/venues/{s['venue']}/events/{s['event']}/end", "admin")
    assert res.status_code == 200, res.text
    url = f"/venues/{s['venue']}/events/{s['event']}/redeem"
    res = api.post(url, "bouncer", {"raw_token": s["gen_token"], "ticket_type_id": s["vip"]})
    assert res.json()["code"] == "EVENT_NOT_LIVE", res.text


def test_redeem_filter_still_rejects_already_redeemed(api):
    """Con filtro, una boleta ya usada sigue siendo ALREADY_REDEEMED."""
    s = _setup_two_rows(api)
    url = f"/venues/{s['venue']}/events/{s['event']}/redeem"
    res = api.post(url, "bouncer", {"raw_token": s["vip_token"], "ticket_type_id": s["vip"]})
    assert res.json()["code"] == "GRANTED", res.text
    res = api.post(url, "bouncer", {"raw_token": s["vip_token"], "ticket_type_id": s["vip"]})
    assert res.json()["code"] == "ALREADY_REDEEMED", res.text
