"""Emision de boletas por HTTP: venta directa desde el panel del admin.

El endpoint de emision no tenia cobertura HTTP: los tests existentes llamaban
a la funcion SQL `emit_ticket` directamente, asi que la capa que traduce SQL a
JSON (y los permisos por rol) quedaba sin verificar. El panel del admin ahora
emite venta directa, y esa ruta depende de que `admin` siga en la lista de
roles permitidos y de que la respuesta traiga el token crudo del QR.
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


def _seed(cur, slug: str, status: str = "published") -> dict:
    """Venue + admin + portero + evento + tipo pagado."""
    cur.execute(
        "INSERT INTO venues (name, slug) VALUES (%s, %s) "
        "ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id",
        (slug, slug),
    )
    vid = cur.fetchone()["id"]

    ids = {}
    for key, email, name in (
        ("admin", f"admin-{slug}@test", f"Admin {slug}"),
        ("bouncer", f"puerta-{slug}@test", f"Puerta {slug}"),
    ):
        cur.execute(
            "INSERT INTO users (email, password_hash, full_name) VALUES (%s, 'x', %s) "
            "ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id",
            (email, name),
        )
        ids[key] = cur.fetchone()["id"]

    for uid, role in ((ids["admin"], "admin"), (ids["bouncer"], "bouncer")):
        cur.execute(
            "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, %s) "
            "ON CONFLICT DO NOTHING",
            (vid, uid, role),
        )

    cur.execute("DELETE FROM events WHERE name=%s", (f"Evento {slug}",))
    cur.execute(
        "INSERT INTO events (venue_id, name, starts_at, capacity, status) "
        "VALUES (%s, %s, now() + interval '3 days', %s, %s) RETURNING id",
        (vid, f"Evento {slug}", 100, status),
    )
    eid = cur.fetchone()["id"]

    cur.execute(
        "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) "
        "VALUES (%s, 'General', 30000, 50, FALSE) RETURNING id",
        (eid,),
    )
    tid = cur.fetchone()["id"]

    return {
        "venue_id": vid,
        "event_id": eid,
        "type_id": tid,
        "admin_id": ids["admin"],
        "bouncer": ids["bouncer"],
    }


def _token(user_id: int, venue_id: int, role: str) -> str:
    return create_access_token(user_id, [venue_id], {venue_id: [role]})


def _emit(client, s, token, **overrides):
    body = {
        "ticket_type_id": s["type_id"],
        "customer_name": "Venta Directa",
        "customer_phone": "573001112233",
    }
    body.update(overrides)
    return client.post(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets",
        headers={"Authorization": f"Bearer {token}"},
        json=body,
    )


def test_admin_can_emit_direct_sale(client, dbcur):
    """El admin emite sin cupo de promotor: es la venta del bar.

    El panel del admin ofrece esta ruta, asi que si el rol deja de estar
    permitido el formulario falla con 403 en plena puerta.
    """
    s = _seed(dbcur, "venta-directa")
    token = _token(s["admin_id"], s["venue_id"], "admin")

    r = _emit(client, s, token)
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["status"] == "issued"
    assert data["ticket_id"] > 0

    # El token crudo va al QR; en la DB solo queda su SHA-256.
    dbcur.execute(
        """
        SELECT t.id, t.allocation_id, t.sold_by_user_id, t.price_cents_snapshot
        FROM tickets t WHERE t.token_hash = encode(digest(%s,'sha256'),'hex')
        """,
        (data["raw_token"],),
    )
    row = dbcur.fetchone()
    assert row is not None, "el token crudo no corresponde a ninguna boleta"
    assert row["allocation_id"] is None, "la venta directa no debe consumir cupo"
    assert row["sold_by_user_id"] == s["admin_id"]
    assert row["price_cents_snapshot"] == 30000, "el precio debe congelarse al emitir"


def test_admin_direct_sale_shows_as_venta_directa_in_list(client, dbcur):
    """La lista del admin distingue venta directa de cupo de promotor."""
    s = _seed(dbcur, "venta-lista")
    token = _token(s["admin_id"], s["venue_id"], "admin")

    assert _emit(client, s, token).status_code == 201

    r = client.get(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    # Mig Fase-2: el listado paginado devuelve {total, items[]} (antes una
    # lista cruda). El total SIEMPRE respeta el corte por promotor.
    body = r.json()
    tickets = body["items"]
    assert body["total"] == 1
    assert len(tickets) == 1
    assert tickets[0]["from_allocation"] is False
    assert tickets[0]["sold_by_name"]


def test_emit_rejected_for_bouncer(client, dbcur):
    """El portero escanea, no emite: el rol no esta en la lista permitida."""
    s = _seed(dbcur, "emite-portero")
    token = _token(s["bouncer"], s["venue_id"], "bouncer")

    r = _emit(client, s, token)
    assert r.status_code == 403, r.text


def test_emit_rejected_on_draft_event(client, dbcur):
    """Un evento en borrador no vende: el panel debe avisarlo antes."""
    s = _seed(dbcur, "emite-borrador", status="draft")
    token = _token(s["admin_id"], s["venue_id"], "admin")

    r = _emit(client, s, token)
    assert r.status_code == 409, r.text
    assert "abierto" in r.json()["detail"]


def test_emit_rejected_on_ended_event(client, dbcur):
    """Cerrado el evento, la taquilla no puede seguir emitiendo."""
    s = _seed(dbcur, "emite-cerrado", status="ended")
    token = _token(s["admin_id"], s["venue_id"], "admin")

    r = _emit(client, s, token)
    assert r.status_code == 409, r.text


def test_paid_ticket_cannot_use_promoter_allocation(client, dbcur):
    """Una boleta de pago contra cupo de promotor descuadra la caja.

    El cupo se asigna para cortesias; el dinero de una boleta pagada no puede
    quedar atribuido a un promotor sin registro de pago.
    """
    s = _seed(dbcur, "pago-con-cupo")
    token = _token(s["admin_id"], s["venue_id"], "admin")

    dbcur.execute(
        "INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity) "
        "VALUES (%s, %s, %s, 5) RETURNING id",
        (s["event_id"], s["type_id"], s["admin_id"]),
    )
    alloc = dbcur.fetchone()["id"]

    r = _emit(client, s, token, allocation_id=alloc)
    assert r.status_code == 400, r.text
    assert "promotor" in r.json()["detail"].lower()