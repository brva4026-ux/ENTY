"""Regresión de los 5 bugs hallados operando un evento de carga (mig 034).

Todos son de COSTURA: cada pieza funcionaba por separado, pero la interacción
entre ciclo de vida, puerta y sync offline no tenía tests. Cada test de aquí
FALLA sin el fix correspondiente.

1. El auto-cierre mataba la puerta: un evento live vencido pasaba a ended y
   redeem_ticket() (que solo acepta live/published) rechazaba TODAS las
   boletas válidas. Y 'ended' era terminal: no había forma de reabrir.
2. El sync offline reenviado contaba la misma entrada dos veces.
3. La cola offline no guardaba el evento (se cubre en el frontend); aquí se
   fija el contrato del server: un token de OTRO evento se rechaza.
4. El sync descartaba la hora real del escaneo.
5. El rate limit en memoria crecía sin límite.
"""
import time
import uuid

import psycopg
import pytest
from psycopg.rows import dict_row

pytestmark = pytest.mark.usefixtures("db")


def _scan(api, venue_id: int, event_id: int, token: str):
    """Un escaneo en línea por la puerta; devuelve el RedeemOut (dict)."""
    res = api.post(
        f"/venues/{venue_id}/events/{event_id}/redeem",
        "bouncer",
        {"raw_token": token},
    )
    assert res.status_code == 200, res.text
    return res.json()


def _set_window(api, event_id: int, *, starts: str, ends: str | None = None) -> None:
    """Mueve la ventana temporal del evento (la API no expone estas columnas)."""
    with psycopg.connect(api.dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            if ends is None:
                cur.execute(
                    f"UPDATE events SET starts_at = now() {starts} WHERE id = %s",
                    (event_id,),
                )
            else:
                cur.execute(
                    f"UPDATE events SET starts_at = now() {starts}, "
                    f"ends_at = now() {ends} WHERE id = %s",
                    (event_id,),
                )


def _door_event(api, world):
    """Evento live con una boleta emitida y la ventana de QR abierta.

    La ventana de QR (mig 013) abre 60 min antes de starts_at; el evento del
    fixture nace +29 h, así que se retrasa starts_at para que el QR esté
    activo (mismo truco que test_door_offline).
    """
    venue = world["venue_a"]
    ev = api.create_event("admin", venue, name="Puerta grace")
    t = api.add_type("admin", venue, ev["id"])
    api.publish("admin", venue, ev["id"])
    api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    _set_window(api, ev["id"], starts="- interval '1 hour'")
    tk = api.emit(
        "admin", venue, ev["id"], ticket_type_id=t["id"], allocation_id=None
    )
    return venue, ev, t, tk


# ---------------------------------------------------------------------------
# 1) La puerta sobrevive a la hora de cierre
# ---------------------------------------------------------------------------


def test_auto_cierre_respeta_la_gracia(api):
    """Un live vencido hace 1 h NO se cierra: la noche se estira (gracia 6 h).

    Antes de la mig 034 pasaba a 'ended' y la puerta empezaba a rechazar
    boletas pagadas en cuanto pasaba el ends_at previsto.
    """
    scen = api.scenario()
    api.post(f"/venues/{scen['venue']}/events/{scen['event']}/live", "admin")
    _set_window(
        api,
        scen["event"],
        starts="- interval '5 hours'",
        ends="- interval '1 hour'",
    )
    closed = api.run_sql("SELECT auto_close_expired_events()")
    assert closed == 0, "un evento vencido hace 1 h no debe cerrarse (gracia 6 h)"
    assert api.event_status(scen["venue"], scen["event"]) == "live"


def test_auto_cierre_tras_la_gracia(api):
    """Pasada la gracia SÍ cierra: la franja no miente para siempre."""
    scen = api.scenario()
    api.post(f"/venues/{scen['venue']}/events/{scen['event']}/live", "admin")
    _set_window(
        api,
        scen["event"],
        starts="- interval '10 hours'",
        ends="- interval '7 hours'",
    )
    closed = api.run_sql("SELECT auto_close_expired_events()")
    assert closed >= 1
    assert api.event_status(scen["venue"], scen["event"]) == "ended"


def test_boleta_valida_entra_durante_la_gracia(api, world):
    """LA REGRESIÓN CENTRAL: el bouncer escanea una boleta pagada a la 1 am
    (el evento decía terminar a las 11 pm) y la DB la ACEPTA."""
    venue, ev, t, tk = _door_event(api, world)
    # El evento sigue live pero con ends_at ya vencido hace 2 h.
    _set_window(
        api, ev["id"], starts="- interval '5 hours'", ends="- interval '2 hours'"
    )
    api.run_sql("SELECT auto_close_expired_events()")
    assert api.event_status(venue, ev["id"]) == "live"
    out = _scan(api, venue, ev["id"], tk["raw_token"])
    assert out["code"] == "GRANTED", "una boleta válida debe entrar durante la gracia"


def test_reabrir_evento_terminado(api, world):
    """'ended' dejó de ser terminal: el admin devuelve la puerta."""
    venue, ev, t, tk = _door_event(api, world)
    api.post(f"/venues/{venue}/events/{ev['id']}/end", "admin")
    assert api.event_status(venue, ev["id"]) == "ended"

    res = api.post(f"/venues/{venue}/events/{ev['id']}/reopen", "admin")
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "live"
    # Y la puerta vuelve a aceptar.
    out = _scan(api, venue, ev["id"], tk["raw_token"])
    assert out["code"] == "GRANTED"


def test_reabrir_requiere_admin(api, world):
    """Un bouncer no reabre eventos."""
    venue, ev, t, tk = _door_event(api, world)
    api.post(f"/venues/{venue}/events/{ev['id']}/end", "admin")
    res = api.post(f"/venues/{venue}/events/{ev['id']}/reopen", "bouncer")
    assert res.status_code == 403


# ---------------------------------------------------------------------------
# 2) Idempotencia del sync offline
# ---------------------------------------------------------------------------


def test_sync_reintento_no_falsea_el_conteo(api, world):
    """Un reintento con el MISMO scan_id no cuenta la entrada dos veces.

    Antes de la mig 034, un POST cortado a mitad obligaba a reenviar la cola
    completa: lo ya canjeado volvía como already_redeemed y el reporte de
    puerta mentía sobre cuántos entraron.
    """
    venue, ev, t, tk = _door_event(api, world)
    scan_id = str(uuid.uuid4())
    body = [{"raw_token": tk["raw_token"], "scan_id": scan_id}]

    first = api.post(f"/venues/{venue}/events/{ev['id']}/door-sync", "bouncer", body)
    assert first.status_code == 200, first.text
    assert first.json()["granted"] == 1

    second = api.post(f"/venues/{venue}/events/{ev['id']}/door-sync", "bouncer", body)
    out = second.json()
    assert out["granted"] == 1, "el reintento devuelve el recibo, no un already"
    assert out["already_redeemed"] == 0
    assert out["results"][0]["scan_id"] == scan_id
    assert out["results"][0]["code"] == "GRANTED"


def test_sync_devuelve_resultado_por_token(api, world):
    """La respuesta trae un resultado POR TOKEN, en orden: el cliente borra de
    IndexedDB solo lo confirmado."""
    venue, ev, t, tk = _door_event(api, world)
    ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    body = [
        {"raw_token": tk["raw_token"], "scan_id": ids[0]},
        {"raw_token": "no-existe-este-token-123", "scan_id": ids[1]},
    ]
    out = api.post(
        f"/venues/{venue}/events/{ev['id']}/door-sync", "bouncer", body
    ).json()
    assert [r["scan_id"] for r in out["results"]] == ids
    assert [r["code"] for r in out["results"]] == ["GRANTED", "NOT_FOUND"]


# ---------------------------------------------------------------------------
# 4) La hora real del escaneo se persiste
# ---------------------------------------------------------------------------


def _scanned_at_of(api, ticket_id: int):
    with psycopg.connect(api.dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT scanned_at FROM redemptions "
                "WHERE ticket_id = %s AND outcome = 'granted'",
                (ticket_id,),
            )
            row = cur.fetchone()
    assert row is not None, "no hay redención 'granted' para esa boleta"
    return row["scanned_at"]


def test_sync_persiste_la_hora_real_del_escaneo(api, world):
    """La hora del escaneo offline viaja al log y al redeemed_at.

    Antes, todo canje offline quedaba con el now() del sync: el reporte de
    puerta mentía sobre CUÁNDO entró cada persona.
    """
    venue, ev, t, tk = _door_event(api, world)
    body = [
        {
            "raw_token": tk["raw_token"],
            "scan_id": str(uuid.uuid4()),
            "scanned_at": "2026-10-25T02:30:00+00:00",
        }
    ]
    out = api.post(
        f"/venues/{venue}/events/{ev['id']}/door-sync", "bouncer", body
    ).json()
    assert out["granted"] == 1
    assert _scanned_at_of(api, tk["ticket_id"]).hour == 2


def test_sync_sanea_una_hora_imposible(api, world):
    """Un reloj roto (hora futura) cae a now(): no contamina la auditoría."""
    venue, ev, t, tk = _door_event(api, world)
    body = [
        {
            "raw_token": tk["raw_token"],
            "scan_id": str(uuid.uuid4()),
            "scanned_at": "2030-01-01T00:00:00+00:00",
        }
    ]
    out = api.post(
        f"/venues/{venue}/events/{ev['id']}/door-sync", "bouncer", body
    ).json()
    assert out["granted"] == 1
    assert _scanned_at_of(api, tk["ticket_id"]).year == time.gmtime().tm_year


# ---------------------------------------------------------------------------
# 3) Un token de OTRO evento no se canjea (contrato del server)
# ---------------------------------------------------------------------------


def test_sync_rechaza_token_de_otro_evento(api, world):
    """La cola del teléfono puede traer tokens de otro evento; el server los
    rechaza (INVALID_EVENT) en vez de dar por buena una entrada ajena."""
    venue, ev_a, t_a, tk = _door_event(api, world)
    ev_b = api.create_event("admin", venue, name="Otro evento")
    api.publish("admin", venue, ev_b["id"])
    api.post(f"/venues/{venue}/events/{ev_b['id']}/live", "admin")
    _set_window(api, ev_b["id"], starts="- interval '1 hour'")

    out = api.post(
        f"/venues/{venue}/events/{ev_b['id']}/door-sync",
        "bouncer",
        [{"raw_token": tk["raw_token"], "scan_id": str(uuid.uuid4())}],
    ).json()
    assert out["granted"] == 0
    assert out["rejected"] == 1
    assert out["results"][0]["code"] == "INVALID_EVENT"


# ---------------------------------------------------------------------------
# 5) El rate limit no crece sin límite
# ---------------------------------------------------------------------------


def test_rate_limit_evicta_cubos_vencidos():
    """El mapa de cubos por IP se poda: antes crecía una entrada por IP para
    siempre (memoria que nunca se libera)."""
    from app.routers import public

    now = time.monotonic()
    public._rate_bucket.clear()
    for i in range(public._RATE_MAX_KEYS + 50):
        public._rate_bucket[f"10.0.{i // 256}.{i % 256}"] = [now - 9999.0]
    public._evict_expired(public._rate_bucket, now, public._RATE_WINDOW)
    assert len(public._rate_bucket) == 0, "los cubos vencidos deben soltarse"

    # Un cubo fresco se conserva.
    public._rate_bucket.clear()
    for i in range(public._RATE_MAX_KEYS + 50):
        public._rate_bucket[f"10.1.{i // 256}.{i % 256}"] = [now - 9999.0]
    public._rate_bucket["192.168.1.1"] = [now]
    public._evict_expired(public._rate_bucket, now, public._RATE_WINDOW)
    assert list(public._rate_bucket) == ["192.168.1.1"]
    public._rate_bucket.clear()
