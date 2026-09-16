"""Tests del reporte del admin (`/summary`): caja e integridad de puerta.

Los numeros que ve el admin tienen que cuadrar con lo que hay en la DB. Si el
reporte miente, el bar cobra mal o no ve que le estan clonando boletas.
"""
import os

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
    ),
)
os.environ.setdefault("JWT_SECRET", "test-secret")

from fastapi.testclient import TestClient  # noqa: E402

from app.core.security import create_access_token  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _seed(cur, slug: str, capacity: int = 100) -> dict:
    """Venue + admin + promotor + evento publicado + tipo pagado + cupo."""
    cur.execute(
        "INSERT INTO venues (name, slug) VALUES (%s, %s) "
        "ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id",
        (slug, slug),
    )
    vid = cur.fetchone()["id"]

    cur.execute(
        "INSERT INTO users (email, password_hash, full_name) "
        "VALUES (%s, 'x', %s) ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id",
        (f"admin-{slug}@test", f"Admin {slug}"),
    )
    admin_id = cur.fetchone()["id"]

    cur.execute(
        "INSERT INTO users (email, password_hash, full_name) "
        "VALUES (%s, 'x', %s) ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id",
        (f"promo-{slug}@test", f"Promo {slug}"),
    )
    promo_id = cur.fetchone()["id"]

    for uid, role in ((admin_id, "admin"), (promo_id, "promotor")):
        cur.execute(
            "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, %s) "
            "ON CONFLICT DO NOTHING",
            (vid, uid, role),
        )

    cur.execute("DELETE FROM events WHERE name=%s", (f"Evento {slug}",))
    cur.execute(
        "INSERT INTO events (venue_id, name, starts_at, capacity, status) "
        "VALUES (%s, %s, now() + interval '3 days', %s, 'live') RETURNING id",
        (vid, f"Evento {slug}", capacity),
    )
    eid = cur.fetchone()["id"]

    cur.execute(
        "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) "
        "VALUES (%s, 'General', 3000000, 50, FALSE) RETURNING id",
        (eid,),
    )
    tid = cur.fetchone()["id"]

    cur.execute(
        "INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity) "
        "VALUES (%s, %s, %s, 5) RETURNING id",
        (eid, tid, promo_id),
    )
    aid = cur.fetchone()["id"]

    return {
        "venue_id": vid,
        "admin_id": admin_id,
        "promo_id": promo_id,
        "event_id": eid,
        "type_id": tid,
        "allocation_id": aid,
    }


def _token(user_id: int, venue_id: int, role: str) -> str:
    return create_access_token(user_id, [venue_id], {venue_id: [role]})


def _emit(cur, s: dict, name: str, token: str, allocation_id: int | None = None) -> int:
    """Emite una boleta. Por defecto venta directa (sin cupo de promotor)."""
    cur.execute(
        "SELECT emit_ticket(%s, %s, %s, %s, %s, %s, NULL, NULL)",
        (s["event_id"], s["type_id"], allocation_id, s["promo_id"], name, token),
    )
    cur.execute(
        "SELECT id FROM tickets WHERE token_hash = encode(digest(%s,'sha256'),'hex')",
        (token,),
    )
    return cur.fetchone()["id"]


def _summary(client, s: dict) -> dict:
    token = _token(s["admin_id"], s["venue_id"], "admin")
    r = client.get(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/summary",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_summary_revenue_matches_sold_tickets(client, dbcur):
    """El ingreso es la suma de las boletas vivas, a precio congelado."""
    s = _seed(dbcur, "caja-basica")
    for i in (1, 2, 3):
        _emit(dbcur, s, f"Cliente {i}", f"tok-caja-{i}")

    rep = _summary(client, s)

    assert rep["issued"] == 3
    assert rep["paid_tickets"] == 3
    assert rep["revenue_cents"] == 3 * 3_000_000
    assert rep["avg_ticket_cents"] == 3_000_000
    assert rep["courtesy_tickets"] == 0


def test_summary_revenue_ignores_voided_and_refunded(client, dbcur):
    """Anular o reembolsar saca la boleta de la caja: no se cobro."""
    s = _seed(dbcur, "caja-anulada")
    ticket_id = _emit(dbcur, s, "Se arrepiente", "tok-void")

    assert _summary(client, s)["revenue_cents"] == 3_000_000

    dbcur.execute("SELECT void_ticket(%s, %s, %s)", (ticket_id, "prueba", s["admin_id"]))

    rep = _summary(client, s)
    assert rep["revenue_cents"] == 0, "una boleta anulada no puede seguir facturando"
    assert rep["issued"] == 0
    assert rep["voided"] == 1


def test_summary_uses_snapshot_price_not_current_price(client, dbcur):
    """Subir el precio del tipo no re-cotiza las boletas ya vendidas."""
    s = _seed(dbcur, "caja-snapshot")
    _emit(dbcur, s, "Compro antes", "tok-snap")

    dbcur.execute(
        "UPDATE ticket_types SET price_cents = 9_000_000 WHERE id=%s", (s["type_id"],)
    )

    rep = _summary(client, s)
    assert rep["revenue_cents"] == 3_000_000, "el precio congelado de la boleta manda"


def test_summary_counts_courtesy_without_inflating_average(client, dbcur):
    """Una cortesia cuenta como boleta pero no como dinero ni promedio."""
    s = _seed(dbcur, "caja-cortesia")
    _emit(dbcur, s, "Paga", "tok-paga")

    dbcur.execute(
        "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) "
        "VALUES (%s, 'Invitado', 0, 10, TRUE) RETURNING id",
        (s["event_id"],),
    )
    cortesia_tid = dbcur.fetchone()["id"]
    dbcur.execute(
        "INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity) "
        "VALUES (%s, %s, %s, 5) RETURNING id",
        (s["event_id"], cortesia_tid, s["promo_id"]),
    )
    cortesia_aid = dbcur.fetchone()["id"]
    dbcur.execute(
        "SELECT emit_ticket(%s, %s, %s, %s, %s, %s, NULL, NULL)",
        (s["event_id"], cortesia_tid, cortesia_aid, s["promo_id"], "Invitado", "tok-cortesia"),
    )

    rep = _summary(client, s)
    assert rep["issued"] == 2
    assert rep["courtesy_tickets"] == 1
    assert rep["paid_tickets"] == 1
    assert rep["revenue_cents"] == 3_000_000
    assert rep["avg_ticket_cents"] == 3_000_000, "el promedio solo mira boletas pagas"


def test_summary_reports_door_integrity(client, dbcur):
    """La puerta tiene que decir cuantos escaneos no cuadraron (S2-3)."""
    s = _seed(dbcur, "puerta-integridad")
    ticket_id = _emit(dbcur, s, "Real", "tok-puerta")

    dbcur.execute("SELECT redeem_ticket(%s, %s, %s)", (s["event_id"], "tok-puerta", s["admin_id"]))
    # Reescaneo del mismo QR: la senal de que alguien duplico la boleta.
    dbcur.execute("SELECT redeem_ticket(%s, %s, %s)", (s["event_id"], "tok-puerta", s["admin_id"]))
    # QR que no existe: captura de pantalla de otro evento o inventado.
    dbcur.execute("SELECT redeem_ticket(%s, %s, %s)", (s["event_id"], "tok-inventado-xx", s["admin_id"]))

    rep = _summary(client, s)
    door = rep["door"]

    assert door["granted"] == 1
    assert door["already_redeemed"] == 1, "un reescaneo debe quedar registrado"
    assert door["not_found"] == 1, "un QR desconocido debe quedar registrado"
    assert door["failed"] == 2
    assert door["total"] == 3
    assert door["last_scan_at"] is not None
    assert door["last_granted_at"] is not None
    assert ticket_id  # la boleta existio y se redimio


def test_summary_door_is_zeroed_when_nobody_scanned(client, dbcur):
    """Sin escaneos el reporte muestra ceros, no nulls (la UI no debe romperse)."""
    s = _seed(dbcur, "puerta-vacia")
    _emit(dbcur, s, "Sin entrar", "tok-nadie")

    door = _summary(client, s)["door"]
    assert door["total"] == 0
    assert door["granted"] == 0
    assert door["failed"] == 0
    assert door["last_scan_at"] is None


def test_summary_by_type_breaks_down_revenue(client, dbcur):
    """El desglose por tipo es lo que dice que tipo de boleta deja la plata."""
    s = _seed(dbcur, "caja-por-tipo")
    _emit(dbcur, s, "General 1", "tok-tipo-1")
    _emit(dbcur, s, "General 2", "tok-tipo-2")

    by_type = _summary(client, s)["by_type"]
    assert len(by_type) == 1
    t = by_type[0]
    assert t["name"] == "General"
    assert t["issued"] == 2
    assert t["revenue_cents"] == 2 * 3_000_000
    assert t["quantity"] == 50


def test_summary_by_promoter_breaks_down_sales(client, dbcur):
    """Cada promotor: cuanto vendio, cuanto entro en puerta y cuanto anulo.

    Las boletas de pago van por venta directa, asi que el desglose por
    promotor se ejerce con cortesias (unico caso ligado a un cupo).
    """
    s = _seed(dbcur, "caja-por-promotor")
    dbcur.execute(
        "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) "
        "VALUES (%s, 'Invitado', 0, 10, TRUE) RETURNING id",
        (s["event_id"],),
    )
    c_tid = dbcur.fetchone()["id"]
    dbcur.execute(
        "INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity) "
        "VALUES (%s, %s, %s, 5) RETURNING id",
        (s["event_id"], c_tid, s["promo_id"]),
    )
    c_aid = dbcur.fetchone()["id"]

    def emit_courtesy(name, token):
        dbcur.execute(
            "SELECT emit_ticket(%s, %s, %s, %s, %s, %s, NULL, NULL)",
            (s["event_id"], c_tid, c_aid, s["promo_id"], name, token),
        )
        dbcur.execute(
            "SELECT id FROM tickets WHERE token_hash = encode(digest(%s,'sha256'),'hex')",
            (token,),
        )
        return dbcur.fetchone()["id"]

    anulada = emit_courtesy("Anulada", "tok-promo-1")
    emit_courtesy("En puerta", "tok-promo-2")
    dbcur.execute("SELECT redeem_ticket(%s, %s, %s)", (s["event_id"], "tok-promo-2", s["admin_id"]))
    dbcur.execute("SELECT void_ticket(%s, %s, %s)", (anulada, "prueba", s["admin_id"]))

    by_promoter = _summary(client, s)["by_promoter"]
    # Dos cupos: el del tipo pagado (vacio) y el de la cortesia (con boletas).
    con_boletas = [p for p in by_promoter if p["issued"] or p["voided"]]
    assert len(con_boletas) == 1, by_promoter
    p = con_boletas[0]
    assert p["capacity"] == 5
    assert p["issued"] == 1, "la anulada no cuenta como vendida"
    assert p["redeemed"] == 1
    assert p["voided"] == 1


def test_summary_is_admin_only(client, dbcur):
    """El promotor y el bouncer no deben ver la caja del bar.

    Los roles se releen de `venue_user_roles` en cada request, asi que hay
    que crear usuarios reales: un rol inventado en el JWT no concede nada.
    """
    s = _seed(dbcur, "caja-permisos")
    _emit(dbcur, s, "Cliente", "tok-perm")

    dbcur.execute(
        "INSERT INTO users (email, password_hash, full_name) "
        "VALUES (%s, 'x', %s) ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id",
        ("bouncer-caja-permisos@test", "Bouncer caja-permisos"),
    )
    bouncer_id = dbcur.fetchone()["id"]
    dbcur.execute(
        "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, 'bouncer') "
        "ON CONFLICT DO NOTHING",
        (s["venue_id"], bouncer_id),
    )

    for uid, role in ((s["promo_id"], "promotor"), (bouncer_id, "bouncer")):
        token = _token(uid, s["venue_id"], role)
        r = client.get(
            f"/venues/{s['venue_id']}/events/{s['event_id']}/summary",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 403, f"{role} no deberia ver los ingresos: {r.text}"

    # El mismo evento si es visible para el admin.
    assert _summary(client, s)["revenue_cents"] == 3_000_000


def test_report_does_not_leak_revenue_to_low_privilege_roles(client, dbcur):
    """`/report` lo ve el promotor y el bouncer: no puede traer dinero.

    Es facil de romper sin darse cuenta: basta agregar `revenue_cents` al
    desglose por tipo y el endpoint de menor privilegio lo empieza a servir.
    """
    s = _seed(dbcur, "report-sin-dinero")
    _emit(dbcur, s, "Cliente", "tok-report")

    for uid, role in ((s["promo_id"], "promotor"), (s["admin_id"], "admin")):
        token = _token(uid, s["venue_id"], role)
        r = client.get(
            f"/venues/{s['venue_id']}/events/{s['event_id']}/report",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200, r.text
        rep = r.json()

        assert "revenue_cents" not in rep
        for t in rep["by_type"]:
            assert "revenue_cents" not in t, f"el reporte filtra ingresos: {t}"
        for p in rep["by_promoter"]:
            assert "revenue_cents" not in p, f"el reporte filtra ingresos: {p}"


def test_summary_rejects_other_venue(client, dbcur):
    """Aislamiento entre venues: un admin ajeno no ve el evento."""
    s = _seed(dbcur, "caja-aislamiento")
    otro = _seed(dbcur, "caja-ajeno")

    token = _token(otro["admin_id"], otro["venue_id"], "admin")
    r = client.get(
        f"/venues/{otro['venue_id']}/events/{s['event_id']}/summary",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 404
