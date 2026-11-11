"""Migración 042: lo que hacía falta para OPERAR y conciliar la noche.

Cubre las tres piezas con lógica de negocio (el gate de turno vive en el
router, por eso también se prueba por HTTP):

1. MEDIO DE PAGO en la emisión y su reflejo en el cierre (arqueo, no suma).
2. MULTI-PUERTA: `door_id` sobrevive al canje en línea y al sync offline.
3. AVISO DE AFORO: un solo aviso por umbral (80% / 90%), no uno por ingreso.
4. TURNO DEL STAFF: fuera de la ventana asignada, la puerta rechaza.
"""
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from psycopg.rows import dict_row

pytestmark = pytest.mark.usefixtures("db")


def _emit(api, venue_id, event_id, *, type_id, payment_method=None, who="admin"):
    body = {
        "ticket_type_id": type_id,
        "customer_name": "Venta Directa",
        "customer_phone": "3001234567",
    }
    if payment_method is not None:
        body["payment_method"] = payment_method
    return api.post(f"/venues/{venue_id}/events/{event_id}/tickets", who, body)


def _payment_method(api, token: str) -> str | None:
    with psycopg.connect(api.dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT payment_method FROM tickets "
                "WHERE token_hash = encode(digest(%s,'sha256'),'hex')",
                (token,),
            )
            row = cur.fetchone()
            return row["payment_method"] if row else None


def _set_window(api, event_id: int, *, starts: str) -> None:
    with psycopg.connect(api.dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE events SET starts_at = now() {starts} WHERE id = %s",
                (event_id,),
            )


def _live_event_with_type(api, world, *, capacity=50, price_cents=30000, quantity=50):
    """Evento live con una fila de pago y la ventana de QR abierta."""
    venue = world["venue_a"]
    ev = api.create_event("admin", venue, capacity=capacity)
    t = api.add_type(
        "admin", venue, ev["id"],
        name="General", price_cents=price_cents, quantity=quantity,
        is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    _set_window(api, ev["id"], starts="- interval '1 hour'")
    return venue, ev["id"], t["id"]


# ---------------------------------------------------------------------------
# 1) Medio de pago
# ---------------------------------------------------------------------------


def test_emit_defaults_to_efectivo_for_paid_ticket(api, world):
    """Sin medio explícito, la taquilla asume efectivo (el caso por defecto)."""
    venue, ev, tid = _live_event_with_type(api, world)
    r = _emit(api, venue, ev, type_id=tid)
    assert r.status_code == 201, r.text
    assert _payment_method(api, r.json()["raw_token"]) == "efectivo"


def test_emit_records_explicit_payment_method(api, world):
    """El medio elegido en la UI llega a la boleta: es lo que hace el arqueo."""
    venue, ev, tid = _live_event_with_type(api, world)
    r = _emit(api, venue, ev, type_id=tid, payment_method="transferencia")
    assert r.status_code == 201, r.text
    assert _payment_method(api, r.json()["raw_token"]) == "transferencia"


def test_free_ticket_is_always_cortesia(api, world):
    """Una boleta gratis es cortesía por definición, aunque pidan otra cosa."""
    venue = world["venue_a"]
    ev = api.create_event("admin", venue)
    t = api.add_type("admin", venue, ev["id"], price_cents=0, is_courtesy=True)
    api.publish("admin", venue, ev["id"])

    r = _emit(api, venue, ev["id"], type_id=t["id"], payment_method="efectivo")
    assert r.status_code == 201, r.text
    assert _payment_method(api, r.json()["raw_token"]) == "cortesia"


def test_invalid_payment_method_is_rejected(api, world):
    """Un medio fuera del catálogo no ensucia la caja: 400, no 500."""
    venue, ev, tid = _live_event_with_type(api, world)
    r = _emit(api, venue, ev, type_id=tid, payment_method="bitcoin")
    assert r.status_code == 422, r.text  # Pydantic Literal corta antes de la DB


def test_payment_method_flows_to_list_and_csv(api, world):
    """El listado y su CSV exponen el medio para conciliar sin abrir la DB."""
    venue, ev, tid = _live_event_with_type(api, world)
    assert _emit(api, venue, ev, type_id=tid, payment_method="transferencia").status_code == 201

    lst = api.get(f"/venues/{venue}/events/{ev}/tickets", "admin").json()
    assert lst["items"][0]["payment_method"] == "transferencia"

    csv = api.get(f"/venues/{venue}/events/{ev}/tickets?format=csv", "admin")
    assert csv.status_code == 200, csv.text
    assert "medio_pago" in csv.text
    assert "transferencia" in csv.text


def test_closing_csv_breaks_cash_down_by_payment_method(api, world):
    """El cierre agrupa por medio: el efectivo es el único número contable
    contra el cajón; el resto se concilia aparte."""
    venue, ev, tid = _live_event_with_type(api, world)
    assert _emit(api, venue, ev, type_id=tid, payment_method="efectivo").status_code == 201
    assert _emit(api, venue, ev, type_id=tid, payment_method="transferencia").status_code == 201

    r = api.get(f"/venues/{venue}/events/{ev}/closing.csv", "admin")
    assert r.status_code == 200, r.text
    assert "Caja por medio de pago" in r.text
    assert "Efectivo" in r.text
    assert "Transferencia" in r.text


def test_report_breaks_cash_down_by_payment_method(api, world):
    """El reporte en vivo trae el desglose de caja por medio de pago."""
    venue, ev, tid = _live_event_with_type(api, world)
    assert _emit(api, venue, ev, type_id=tid, payment_method="efectivo").status_code == 201
    assert _emit(api, venue, ev, type_id=tid, payment_method="transferencia").status_code == 201

    r = api.get(f"/venues/{venue}/events/{ev}/report", "admin")
    assert r.status_code == 200, r.text
    by_pm = {row["payment_method"]: row for row in r.json()["by_payment_method"]}
    assert by_pm["efectivo"]["tickets"] == 1
    assert by_pm["efectivo"]["revenue_cents"] == 30000
    assert by_pm["transferencia"]["tickets"] == 1


def test_report_breakdowns_hidden_from_promoter(api, world):
    """El promotor no ve el desglose de caja ni el de puerta: es dato del bar."""
    venue, ev, tid = _live_event_with_type(api, world)
    assert _emit(api, venue, ev, type_id=tid).status_code == 201

    r = api.get(f"/venues/{venue}/events/{ev}/report", "promoter")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["by_payment_method"] == []
    assert body["by_door"] == []


def test_report_breaks_door_down_by_access(api, world):
    """El reporte agrupa los escaneos por puerta de origen."""
    venue, ev, tid = _live_event_with_type(api, world)
    tk1 = _emit(api, venue, ev, type_id=tid).json()
    tk2 = _emit(api, venue, ev, type_id=tid).json()

    api.post(
        f"/venues/{venue}/events/{ev}/redeem", "bouncer",
        {"raw_token": tk1["raw_token"], "door_id": "puerta-1"},
    )
    api.post(
        f"/venues/{venue}/events/{ev}/redeem", "bouncer",
        {"raw_token": tk2["raw_token"], "door_id": "puerta-2"},
    )

    r = api.get(f"/venues/{venue}/events/{ev}/report", "admin")
    assert r.status_code == 200, r.text
    by_door = {row["door_id"]: row for row in r.json()["by_door"]}
    assert by_door["puerta-1"]["granted"] == 1
    assert by_door["puerta-2"]["granted"] == 1


# ---------------------------------------------------------------------------
# 2) Multi-puerta
# ---------------------------------------------------------------------------


def test_redeem_records_door_id(api, world):
    """Cada ingreso queda atado a la puerta por la que entró."""
    venue, ev, tid = _live_event_with_type(api, world)
    tk = _emit(api, venue, ev, type_id=tid).json()

    res = api.post(
        f"/venues/{venue}/events/{ev}/redeem",
        "bouncer",
        {"raw_token": tk["raw_token"], "door_id": "puerta-2"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["code"] == "GRANTED"

    with psycopg.connect(api.dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT door_id FROM redemptions WHERE event_id = %s AND outcome='granted'",
                (ev,),
            )
            assert cur.fetchone()["door_id"] == "puerta-2"


def test_door_sync_preserves_door_id(api, world):
    """Una entrada validada offline conserva su puerta al sincronizar."""
    venue, ev, tid = _live_event_with_type(api, world)
    tk = _emit(api, venue, ev, type_id=tid).json()

    res = api.post(
        f"/venues/{venue}/events/{ev}/door-sync",
        "bouncer",
        [
            {
                "raw_token": tk["raw_token"],
                "door_id": "VIP",
                "scanned_at": datetime.now(timezone.utc).isoformat(),
            }
        ],
    )
    assert res.status_code == 200, res.text

    with psycopg.connect(api.dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT door_id FROM redemptions WHERE event_id = %s AND outcome='granted'",
                (ev,),
            )
            assert cur.fetchone()["door_id"] == "VIP"


# ---------------------------------------------------------------------------
# 3) Aviso de aforo
# ---------------------------------------------------------------------------


def _capacity_alerts(api, venue_id: int) -> list[dict]:
    with psycopg.connect(api.dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT title FROM notifications "
                "WHERE venue_id = %s AND kind = 'capacity_alert' ORDER BY id",
                (venue_id,),
            )
            return cur.fetchall()


def test_capacity_alert_fires_once_per_threshold(api, world):
    """Cruzar 80% y 90% avisa UNA vez cada uno; el 3er ingreso al 80% no."""
    # Capacidad 10 -> 80% = 8, 90% = 9. Diez boletas emitidas, se canjean.
    venue, ev, tid = _live_event_with_type(
        api, world, capacity=10, quantity=10
    )
    tokens = [
        _emit(api, venue, ev, type_id=tid).json()["raw_token"] for _ in range(10)
    ]

    for raw in tokens[:7]:  # 7 ingresos: por debajo del 80%
        api.post(
            f"/venues/{venue}/events/{ev}/redeem", "bouncer", {"raw_token": raw}
        )
    assert _capacity_alerts(api, venue) == [], "no debe avisar antes del 80%"

    api.post(f"/venues/{venue}/events/{ev}/redeem", "bouncer", {"raw_token": tokens[7]})
    alerts = _capacity_alerts(api, venue)
    assert len(alerts) == 1 and "80%" in alerts[0]["title"]

    api.post(f"/venues/{venue}/events/{ev}/redeem", "bouncer", {"raw_token": tokens[8]})
    alerts = _capacity_alerts(api, venue)
    assert [a["title"] for a in alerts] == ["Aforo al 80%", "Aforo al 90%"]

    api.post(f"/venues/{venue}/events/{ev}/redeem", "bouncer", {"raw_token": tokens[9]})
    assert len(_capacity_alerts(api, venue)) == 2, "no avisa en cada ingreso posterior"


# ---------------------------------------------------------------------------
# 4) Turno del staff
# ---------------------------------------------------------------------------


def _assign_shift(api, venue_id: int, event_id: int, user_id: int, *, start, end):
    res = api.post(
        f"/venues/{venue_id}/events/{event_id}/staff",
        "admin",
        {
            "user_id": user_id,
            "role": "bouncer",
            "shift_start": start.isoformat(),
            "shift_end": end.isoformat(),
        },
    )
    assert res.status_code == 201, res.text


def test_redeem_rejected_outside_shift(api, world):
    """Fuera de su ventana, el bouncer no abre la puerta: el turno se respeta."""
    venue, ev, tid = _live_event_with_type(api, world)
    tk = _emit(api, venue, ev, type_id=tid).json()

    past = datetime.now(timezone.utc) - timedelta(hours=6)
    _assign_shift(
        api, venue, ev, world["bouncer"]["id"],
        start=past - timedelta(hours=2), end=past,
    )

    res = api.post(
        f"/venues/{venue}/events/{ev}/redeem",
        "bouncer",
        {"raw_token": tk["raw_token"]},
    )
    assert res.status_code == 403, res.text
    assert "turno" in res.json()["detail"].lower()


def test_redeem_allowed_inside_shift(api, world):
    """Dentro de la ventana, la puerta abre con normalidad."""
    venue, ev, tid = _live_event_with_type(api, world)
    tk = _emit(api, venue, ev, type_id=tid).json()

    now = datetime.now(timezone.utc)
    _assign_shift(
        api, venue, ev, world["bouncer"]["id"],
        start=now - timedelta(hours=1), end=now + timedelta(hours=5),
    )

    res = api.post(
        f"/venues/{venue}/events/{ev}/redeem",
        "bouncer",
        {"raw_token": tk["raw_token"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["code"] == "GRANTED"


def test_redeem_without_shift_is_unrestricted(api, world):
    """Sin turno asignado, la ausencia de dato NO cierra la puerta."""
    venue, ev, tid = _live_event_with_type(api, world)
    tk = _emit(api, venue, ev, type_id=tid).json()

    res = api.post(
        f"/venues/{venue}/events/{ev}/redeem",
        "bouncer",
        {"raw_token": tk["raw_token"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["code"] == "GRANTED"


def test_admin_ignores_shift_gate(api, world):
    """El admin cubre huecos de último minuto: no lo ata un turno de bouncer."""
    venue, ev, tid = _live_event_with_type(api, world)
    tk = _emit(api, venue, ev, type_id=tid).json()

    past = datetime.now(timezone.utc) - timedelta(hours=6)
    _assign_shift(
        api, venue, ev, world["admin"]["id"],
        start=past - timedelta(hours=2), end=past,
    )

    res = api.post(
        f"/venues/{venue}/events/{ev}/redeem",
        "admin",
        {"raw_token": tk["raw_token"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["code"] == "GRANTED"
