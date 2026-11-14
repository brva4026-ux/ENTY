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
5. El rate limit en memoria crecía sin límite y no servía en serverless; ahora
   vive en la DB (mig 041) y se prueba ahí.
"""
import time
import uuid
from datetime import datetime, timedelta, timezone

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


def test_sync_un_scan_id_roto_no_pierde_la_entrada(api, world):
    """Un scan_id que no es uuid no debe costar una entrada.

    El cliente genera uuid v4, pero un teléfono viejo (o un dato corrupto)
    podría mandar otra cosa. El recibo es una optimización: si no se puede
    escribir, el canje ya ocurrió y la respuesta debe seguir siendo el
    resultado REAL (no un INVALID), porque el cliente conserva en su cola
    solo lo que no pudo confirmar.
    """
    venue, ev, t, tk = _door_event(api, world)
    out = api.post(
        f"/venues/{venue}/events/{ev['id']}/door-sync",
        "bouncer",
        [{"raw_token": tk["raw_token"], "scan_id": "no-soy-un-uuid"}],
    ).json()
    assert out["granted"] == 1, "el canje ocurrió: la respuesta no puede mentir"
    assert out["results"][0]["code"] == "GRANTED"
    assert out["results"][0]["scan_id"] == "no-soy-un-uuid"


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

    La marca es RELATIVA (hace 3 días a las 02:30 UTC), no una fecha clavada en
    el código: redeem_ticket() sanea a now() todo lo anterior a now() - 7 días,
    así que una fecha fija se vuelve bomba de tiempo — el día que envejece, el
    sync la pisa con now() y el test falla sin que el producto haya cambiado.
    """
    venue, ev, t, tk = _door_event(api, world)
    scanned = (datetime.now(timezone.utc) - timedelta(days=3)).replace(
        hour=2, minute=30, second=0, microsecond=0
    )
    body = [
        {
            "raw_token": tk["raw_token"],
            "scan_id": str(uuid.uuid4()),
            "scanned_at": scanned.isoformat(),
        }
    ]
    out = api.post(
        f"/venues/{venue}/events/{ev['id']}/door-sync", "bouncer", body
    ).json()
    assert out["granted"] == 1
    assert _scanned_at_of(api, tk["ticket_id"]).astimezone(timezone.utc) == scanned


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
# 5) El rate limit es real en serverless (vive en la DB, mig 041)
# ---------------------------------------------------------------------------


def test_rate_limit_hit_en_db_cuenta_y_corta(dbcur):
    """`rate_limit_hit` permite hasta el cupo y luego corta; un rechazo NO se
    registra (si contara, la ventana se autoextendería sin fin)."""
    key = f"test:{uuid.uuid4().hex}"

    def hit(max_hits: int, window: int) -> bool:
        return dbcur.execute(
            "SELECT rate_limit_hit(%s, %s, %s) AS ok", (key, max_hits, window)
        ).fetchone()["ok"]

    assert [hit(3, 60) for _ in range(3)] == [True, True, True]
    assert hit(3, 60) is False, "el 4to impacto debe cortarse (cupo 3)"
    # El rechazo no se registró: siguen 3 filas, no 4.
    n = dbcur.execute(
        "SELECT count(*) AS n FROM rate_limit_hits WHERE key = %s", (key,)
    ).fetchone()["n"]
    assert n == 3, "un rechazo no debe registrarse"

    # Otra clave no se ve afectada (aísla por scope:ip).
    other = dbcur.execute(
        "SELECT rate_limit_hit(%s, 1, 60) AS ok", (key + ":otra",)
    ).fetchone()["ok"]
    assert other is True

    dbcur.execute("DELETE FROM rate_limit_hits WHERE key LIKE %s", (key + "%",))


def test_catalogo_publico_corta_tras_el_cupo(api_client, dbcur):
    """El catálogo usa el limiter en DB: pasada la ventana de 120/min, 429."""
    ip = f"10.9.{uuid.uuid4().int % 256}.{uuid.uuid4().int % 256}"
    key = f"public:catalog:{ip}"
    dbcur.execute("DELETE FROM rate_limit_hits WHERE key = %s", (key,))
    # Se siembra el cupo ya agotado para esta IP: el siguiente request corta.
    for _ in range(120):
        dbcur.execute("SELECT rate_limit_hit(%s, 120, 60)", (key,))
    res = api_client.get("/public/events", headers={"x-real-ip": ip})
    assert res.status_code == 429, res.text


# ---------------------------------------------------------------------------
# 6) El cierre no depende de que el ADMIN abra su panel (Ley de Tesler)
# ---------------------------------------------------------------------------


def test_el_cierre_ocurre_desde_el_panel_del_promotor(api, world):
    """`auto_close_expired_events()` corría SOLO en `GET /events` (panel admin).

    Un evento vencido seguía 'En puerta' para el promotor, la puerta y la
    vitrina hasta que un admin abría su panel. Ahora también lo disparan
    `/events/mine` (promotor), `/overview` (caja) y `/door-snapshot` (puerta):
    el cierre no depende de que pase el admin.
    """
    venue = world["venue_a"]
    ev = api.create_event("admin", venue, name="Cierre por promotor")
    t = api.add_type("admin", venue, ev["id"])
    api.publish("admin", venue, ev["id"])
    api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    # Asignar al promotor a la noche (sin roster, /events/mine no lo lista).
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/staff",
        "admin",
        {"user_id": world["promoter"]["id"], "role": "promotor"},
    )
    assert res.status_code in (200, 201), res.text
    # Vencer el evento bien pasada la gracia (6 h).
    _set_window(
        api, ev["id"], starts="- interval '10 hours'", ends="- interval '7 hours'"
    )
    assert api.event_status(venue, ev["id"]) == "live"

    # El promotor abre SU panel: no hay admin de por medio.
    res = api.get(f"/venues/{venue}/events/mine", "promoter")
    assert res.status_code == 200, res.text

    assert api.event_status(venue, ev["id"]) == "ended", (
        "el cierre debe ocurrir aunque solo el promotor abra su panel"
    )


def test_el_cierre_ocurre_desde_la_caja(api):
    """`/overview` (Negocio) también dispara el watchdog."""
    scen = api.scenario()
    api.post(f"/venues/{scen['venue']}/events/{scen['event']}/live", "admin")
    _set_window(
        api,
        scen["event"],
        starts="- interval '10 hours'",
        ends="- interval '7 hours'",
    )
    assert api.event_status(scen["venue"], scen["event"]) == "live"

    res = api.get(f"/venues/{scen['venue']}/overview", "admin")
    assert res.status_code == 200, res.text
    assert api.event_status(scen["venue"], scen["event"]) == "ended"
