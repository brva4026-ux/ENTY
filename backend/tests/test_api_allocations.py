"""Tests de la API HTTP (no solo de las funciones SQL).

Aqui vive la capa que traduce SQL a JSON para la UI: un campo que la DB
tiene pero el schema no expone rompe la pantalla sin romper ningun test de
negocio. El caso concreto: el medidor de cupo del promotor ("Usados X/Y")
lee `allocation.issued`, asi que la API debe exponerlo.
"""
import os

import pytest

# El conftest resuelve la DB con TEST_DATABASE_URL, pero la app la lee de
# DATABASE_URL. Se alinean ANTES de importar la app (get_settings es lru_cache).
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
    """Venue + admin + evento publicado + tipo cortesia + cupo de promotor."""
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
        "VALUES (%s, %s, now() + interval '3 days', %s, 'published') RETURNING id",
        (vid, f"Evento {slug}", capacity),
    )
    eid = cur.fetchone()["id"]

    cur.execute(
        "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) "
        "VALUES (%s, 'Cortesia', 0, 50, TRUE) RETURNING id",
        (eid,),
    )
    tid = cur.fetchone()["id"]

    cur.execute(
        "INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity) "
        "VALUES (%s, %s, %s, 3) RETURNING id",
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


def test_allocations_expose_issued_count(client, dbcur):
    """El cupo debe reportar cuantas boletas se emitieron contra el.

    Sin esto el dashboard muestra 'Usados 0/3' aunque el cupo este consumido,
    y el promotor no sabe cuanto le queda (historia S1-4: asignar cupos).
    """
    s = _seed(dbcur, "cupo-issued")
    token = _token(s["admin_id"], s["venue_id"], "admin")

    # Dos boletas contra el cupo (la tercera queda libre).
    for i in (1, 2):
        dbcur.execute(
            "SELECT emit_ticket(%s, %s, %s, %s, %s, %s, NULL, NULL)",
            (s["event_id"], s["type_id"], s["allocation_id"], s["promo_id"], f"A{i}", f"tok-{i}"),
        )

    r = client.get(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/allocations",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    allocs = r.json()
    assert len(allocs) == 1

    a = allocs[0]
    assert a["issued"] == 2, f"la API no reporta las boletas emitidas: {a}"
    assert a["capacity"] == 3


def test_allocations_issued_ignores_voided_tickets(client, dbcur):
    """Una boleta anulada libera cupo (mismo criterio que emit_ticket)."""
    s = _seed(dbcur, "cupo-voided")
    token = _token(s["admin_id"], s["venue_id"], "admin")

    dbcur.execute(
        "SELECT emit_ticket(%s, %s, %s, %s, %s, %s, NULL, NULL)",
        (s["event_id"], s["type_id"], s["allocation_id"], s["promo_id"], "Anulable", "tok-v1"),
    )
    dbcur.execute(
        "SELECT id FROM tickets WHERE token_hash = encode(digest('tok-v1','sha256'),'hex')"
    )
    ticket_id = dbcur.fetchone()["id"]
    dbcur.execute("SELECT void_ticket(%s, %s, %s)", (ticket_id, "prueba", s["admin_id"]))

    r = client.get(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/allocations",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()[0]["issued"] == 0, "una boleta anulada no debe consumir cupo"