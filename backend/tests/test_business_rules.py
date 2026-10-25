"""Tests de negocio de TicketFlow — nivel DB (las funciones plpgsql son la fuente de verdad).

Ejecutar:
    cd backend && ./.venv/Scripts/python.exe -m pytest tests/ -v

Requiere la DB de prueba (TEST_DATABASE_URL o la local por defecto).
Los invariantes probados son los que impiden perder dinero en un evento real:
sobreventa, reuso de boletas y ventas fuera de ventana.
"""
import secrets

import psycopg
import pytest


# ---------------------------------------------------------------------------
# Helpers de escenario
# ---------------------------------------------------------------------------
def _venue(cur, slug) -> int:
    cur.execute(
        "INSERT INTO venues (name, slug) VALUES (%s, %s) "
        "ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id",
        (slug, slug),
    )
    return cur.fetchone()["id"]


def _user(cur, email) -> int:
    cur.execute(
        "INSERT INTO users (email, password_hash, full_name) "
        "VALUES (%s, 'x', %s) ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id",
        (email, email),
    )
    return cur.fetchone()["id"]


def _role(cur, venue_id, user_id, role):
    cur.execute(
        "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
        (venue_id, user_id, role),
    )


def _event(cur, venue_id, name, capacity, status="published") -> int:
    cur.execute("DELETE FROM events WHERE name=%s", (name,))
    cur.execute(
        # starts_at en el pasado: la boleta nace ACTIVA (ventana de
        # activacion del QR ya abierta, mig 013) y el evento publicado
        # acepta canje (guard de la mig 006).
        "INSERT INTO events (venue_id, name, starts_at, capacity, status) "
        "VALUES (%s, %s, now() - interval '2 hours', %s, %s) RETURNING id",
        (venue_id, name, capacity, status),
    )
    return cur.fetchone()["id"]


def _type(cur, event_id, name, qty, price=0) -> int:
    cur.execute(
        "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) "
        "VALUES (%s, %s, %s, %s, %s) RETURNING id",
        (event_id, name, price, qty, price == 0),
    )
    return cur.fetchone()["id"]


def _alloc(cur, event_id, type_id, promoter_id, capacity) -> int:
    cur.execute(
        "INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity) "
        "VALUES (%s, %s, %s, %s) RETURNING id",
        (event_id, type_id, promoter_id, capacity),
    )
    return cur.fetchone()["id"]


def _emit(cur, event_id, type_id, alloc, user, name, token=None):
    token = token or secrets.token_urlsafe(24)
    cur.execute(
        "SELECT emit_ticket(%s, %s, %s, %s, %s, %s, NULL, NULL)",
        (event_id, type_id, alloc, user, name, token),
    )
    return token


def _err_code(fn):
    """Ejecuta fn() y devuelve el identificador del error de negocio esperado."""
    try:
        fn()
    except psycopg.errors.Error as e:
        return getattr(e, "diag", None) and e.diag.message_primary or str(e)
    return None


# ---------------------------------------------------------------------------
# Sobreventa
# ---------------------------------------------------------------------------
def test_promoter_quota_is_enforced(dbcur):
    v = _venue(dbcur, "t-quota")
    u = _user(dbcur, "quota@test.co")
    _role(dbcur, v, u, "promotor")
    e = _event(dbcur, v, "Quota Event", capacity=100)
    t = _type(dbcur, e, "General", qty=50)
    a = _alloc(dbcur, e, t, u, capacity=2)

    _emit(dbcur, e, t, a, u, "Uno")
    _emit(dbcur, e, t, a, u, "Dos")
    code = _err_code(lambda: _emit(dbcur, e, t, a, u, "Tres"))
    assert code and "promoter_quota_exceeded" in code


def test_event_capacity_cannot_be_exceeded(dbcur):
    v = _venue(dbcur, "t-cap")
    u = _user(dbcur, "cap@test.co")
    e = _event(dbcur, v, "Cap Event", capacity=2)
    t = _type(dbcur, e, "General", qty=100)

    _emit(dbcur, e, t, None, u, "Uno")
    _emit(dbcur, e, t, None, u, "Dos")
    code = _err_code(lambda: _emit(dbcur, e, t, None, u, "Tres"))
    assert code and "event_at_capacity" in code


def test_type_inventory_cannot_exceed_aforo(dbcur):
    """El bug real: N tipos pueden exceder el aforo total entre todos."""
    v = _venue(dbcur, "t-types")
    u = _user(dbcur, "types@test.co")
    e = _event(dbcur, v, "Types Event", capacity=3)
    _type(dbcur, e, "A", qty=10)
    _type(dbcur, e, "B", qty=10)

    dbcur.execute("SELECT id FROM ticket_types WHERE event_id=%s AND name='A'", (e,))
    ta = dbcur.fetchone()["id"]
    dbcur.execute("SELECT id FROM ticket_types WHERE event_id=%s AND name='B'", (e,))
    tb = dbcur.fetchone()["id"]

    _emit(dbcur, e, ta, None, u, "A1")
    _emit(dbcur, e, tb, None, u, "B1")
    _emit(dbcur, e, ta, None, u, "A2")
    # 4ta boleta excede el aforo fisico (3) aunque los tipos tengan cupo libre
    code = _err_code(lambda: _emit(dbcur, e, tb, None, u, "B2"))
    assert code and ("event_at_capacity" in code or "ticket_type_sold_out" in code)


def test_type_inventory_is_per_type_not_a_shared_pool(dbcur):
    """Bug real (mig 033): el tope de una localidad se medía contra la SUMA de
    quantities de todas, así que una localidad chica se podía sobrevender con
    el sobrante de las demás. Con aforo holgado, "VIP" (5) debe cortar en 5
    aunque "General" tenga 50 libres."""
    v = _venue(dbcur, "t-pertype")
    u = _user(dbcur, "pertype@test.co")
    e = _event(dbcur, v, "PerType Event", capacity=100)
    tg = _type(dbcur, e, "General", qty=50)
    tv = _type(dbcur, e, "VIP", qty=5)

    for i in range(5):
        _emit(dbcur, e, tv, None, u, f"VIP {i}")

    # La 6ta boleta VIP debe rebotar por inventario de ESA localidad, no por aforo.
    code = _err_code(lambda: _emit(dbcur, e, tv, None, u, "VIP 6"))
    assert code and "ticket_type_sold_out" in code

    # Y "General" sigue vendiendo: el rechazo fue de la localidad, no del evento.
    _emit(dbcur, e, tg, None, u, "General 1")


# ---------------------------------------------------------------------------
# Anti-reuso (compare-and-swap)
# ---------------------------------------------------------------------------
def test_redeem_cas_only_once(dbcur):
    v = _venue(dbcur, "t-reuse")
    u = _user(dbcur, "reuse@test.co")
    e = _event(dbcur, v, "Reuse Event", capacity=10, status="live")
    t = _type(dbcur, e, "General", qty=10)

    token = _emit(dbcur, e, t, None, u, "Invitado")
    dbcur.execute("SELECT redeem_ticket(%s, %s, %s)", (e, token, u))
    assert dbcur.fetchone()["redeem_ticket"] == "GRANTED"
    dbcur.execute("SELECT redeem_ticket(%s, %s, %s)", (e, token, u))
    assert dbcur.fetchone()["redeem_ticket"] == "ALREADY_REDEEMED"


# ---------------------------------------------------------------------------
# Ventana de venta
# ---------------------------------------------------------------------------
def test_draft_event_rejects_sales(dbcur):
    v = _venue(dbcur, "t-draft")
    u = _user(dbcur, "draft@test.co")
    e = _event(dbcur, v, "Draft Event", capacity=10, status="draft")
    t = _type(dbcur, e, "General", qty=10)

    code = _err_code(lambda: _emit(dbcur, e, t, None, u, "X"))
    assert code and "event_not_open_for_sales" in code


def test_ended_event_rejects_sales(dbcur):
    """El fix nuevo de la 003: un evento terminado no puede seguir vendiendo."""
    v = _venue(dbcur, "t-ended")
    u = _user(dbcur, "ended@test.co")
    e = _event(dbcur, v, "Ended Event", capacity=10, status="ended")
    t = _type(dbcur, e, "General", qty=10)

    code = _err_code(lambda: _emit(dbcur, e, t, None, u, "X"))
    assert code and "event_not_open_for_sales" in code


# ---------------------------------------------------------------------------
# Ciclo de vida
# ---------------------------------------------------------------------------
def test_publish_live_end_happy_path(dbcur):
    v = _venue(dbcur, "t-life")
    u = _user(dbcur, "life@test.co")
    e = _event(dbcur, v, "Life Event", capacity=10, status="draft")
    t = _type(dbcur, e, "General", qty=10)

    dbcur.execute("SELECT set_event_status(%s, 'draft', 'published')", (e,))
    dbcur.execute("SELECT set_event_status(%s, 'published', 'live')", (e,))
    dbcur.execute("SELECT set_event_status(%s, 'live', 'ended')", (e,))
    dbcur.execute("SELECT status FROM events WHERE id=%s", (e,))
    assert dbcur.fetchone()["status"] == "ended"


def test_invalid_transition_rejected(dbcur):
    v = _venue(dbcur, "t-invalid")
    u = _user(dbcur, "invalid@test.co")
    e = _event(dbcur, v, "Invalid Event", capacity=10, status="draft")
    _type(dbcur, e, "General", qty=10)

    # live directo desde draft: inválido
    code = _err_code(lambda: dbcur.execute("SELECT set_event_status(%s, 'published', 'live')", (e,)))
    assert code and "invalid_transition" in code


def test_void_frees_quota(dbcur):
    v = _venue(dbcur, "t-void")
    u = _user(dbcur, "void@test.co")
    _role(dbcur, v, u, "promotor")
    e = _event(dbcur, v, "Void Event", capacity=10)
    t = _type(dbcur, e, "General", qty=10)
    a = _alloc(dbcur, e, t, u, capacity=1)

    token = _emit(dbcur, e, t, a, u, "Uno")
    code = _err_code(lambda: _emit(dbcur, e, t, a, u, "Dos"))
    assert code and "promoter_quota_exceeded" in code

    # anular la boleta del evento (void_ticket devuelve event_id)
    dbcur.execute(
        "SELECT t.id FROM tickets t WHERE t.token_hash=encode(digest(%s,'sha256'),'hex')",
        (token,),
    )
    tid = dbcur.fetchone()["id"]
    dbcur.execute("SELECT void_ticket(%s, 'test', %s)", (tid, u))
    assert dbcur.fetchone()["void_ticket"] == e

    # el cupo quedó liberado: la segunda emisión ahora sí pasa
    _emit(dbcur, e, t, a, u, "Dos")


# ---------------------------------------------------------------------------
# Auditoría de escaneos
# ---------------------------------------------------------------------------
def test_not_found_scan_is_audited(dbcur):
    v = _venue(dbcur, "t-audit")
    u = _user(dbcur, "audit@test.co")
    e = _event(dbcur, v, "Audit Event", capacity=10, status="live")

    dbcur.execute("SELECT redeem_ticket(%s, %s, %s)", (e, "no-existe-este-token-123", u))
    assert dbcur.fetchone()["redeem_ticket"] == "NOT_FOUND"
    dbcur.execute(
        "SELECT count(*) FROM redemptions WHERE event_id=%s AND outcome='not_found' AND ticket_id IS NULL",
        (e,),
    )
    assert dbcur.fetchone()["count"] >= 1
