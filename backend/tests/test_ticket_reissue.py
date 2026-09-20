"""Recuperacion de boletas: reemision y listado propio.

Contexto: el token crudo del QR se entrega UNA vez al emitir y en la DB solo
queda su SHA-256. Si el WhatsApp no salio o el invitado borro el chat, la
boleta era irrecuperable: no habia endpoint de reimpresion y el promotor ni
siquiera podia listar sus propias boletas.

La recuperacion NO puede devolver el token viejo (el hash es de una via, y
guardar el crudo anularia su proposito). Se rota: token nuevo, mismo cupo,
mismo aforo, y el anterior muere. Estos tests fijan esas garantias.
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
    """Venue + admin + dos promotores + evento publicado + cupo por promotor."""
    cur.execute(
        "INSERT INTO venues (name, slug) VALUES (%s, %s) "
        "ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id",
        (slug, slug),
    )
    vid = cur.fetchone()["id"]

    ids = {}
    for key, email, name in (
        ("admin", f"admin-{slug}@test", f"Admin {slug}"),
        ("p1", f"promo1-{slug}@test", f"Promo1 {slug}"),
        ("p2", f"promo2-{slug}@test", f"Promo2 {slug}"),
    ):
        cur.execute(
            "INSERT INTO users (email, password_hash, full_name) VALUES (%s, 'x', %s) "
            "ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id",
            (email, name),
        )
        ids[key] = cur.fetchone()["id"]

    for uid, role in ((ids["admin"], "admin"), (ids["p1"], "promotor"), (ids["p2"], "promotor")):
        cur.execute(
            "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, %s) "
            "ON CONFLICT DO NOTHING",
            (vid, uid, role),
        )

    cur.execute("DELETE FROM events WHERE name=%s", (f"Evento {slug}",))
    cur.execute(
        # starts_at en el pasado: QR ya activo (mig 013) y canje permitido (006)
        "INSERT INTO events (venue_id, name, starts_at, capacity, status) "
        "VALUES (%s, %s, now() - interval '2 hours', %s, 'published') RETURNING id",
        (vid, f"Evento {slug}", capacity),
    )
    eid = cur.fetchone()["id"]

    cur.execute(
        "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) "
        "VALUES (%s, 'Cortesia', 0, 50, TRUE) RETURNING id",
        (eid,),
    )
    tid = cur.fetchone()["id"]

    allocs = {}
    for key in ("p1", "p2"):
        cur.execute(
            "INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity) "
            "VALUES (%s, %s, %s, 5) RETURNING id",
            (eid, tid, ids[key]),
        )
        allocs[key] = cur.fetchone()["id"]

    return {
        "venue_id": vid,
        "admin_id": ids["admin"],
        "p1": ids["p1"],
        "p2": ids["p2"],
        "event_id": eid,
        "type_id": tid,
        "alloc_p1": allocs["p1"],
        "alloc_p2": allocs["p2"],
    }


def _token(user_id: int, venue_id: int, role: str) -> str:
    return create_access_token(user_id, [venue_id], {venue_id: [role]})


def _issue(client, s, promoter_key="p1"):
    """Emite una boleta via API y devuelve (ticket_id, raw_token)."""
    tok = _token(s[promoter_key], s["venue_id"], "promotor")
    alloc = s["alloc_p1"] if promoter_key == "p1" else s["alloc_p2"]
    r = client.post(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets",
        headers={"Authorization": f"Bearer {tok}"},
        json={
            "ticket_type_id": s["type_id"],
            "allocation_id": alloc,
            "customer_name": "Invitado Prueba",
            "customer_phone": "573001234567",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["ticket_id"], r.json()["raw_token"]


def _redeem(client, s, raw_token):
    tok = _token(s["admin_id"], s["venue_id"], "admin")
    return client.post(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/redeem",
        headers={"Authorization": f"Bearer {tok}"},
        json={"raw_token": raw_token},
    )


def test_reissue_rotates_token_and_kills_the_old_one(client, dbcur):
    """El caso reportado: se perdio el QR y hay que volver a tener uno valido.

    El token nuevo debe servir para ver la boleta y para que la puerta lo
    redima; el viejo debe morir, o el reenvio seria un agujero (dos QR vivos
    para una sola entrada).
    """
    s = _seed(dbcur, "reissue-basico")
    ticket_id, old_token = _issue(client, s)
    ptok = _token(s["p1"], s["venue_id"], "promotor")

    r = client.post(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets/{ticket_id}/reissue",
        headers={"Authorization": f"Bearer {ptok}"},
        json={"reason": "no le llego el whatsapp"},
    )
    assert r.status_code == 200, r.text
    new_token = r.json()["raw_token"]

    assert new_token != old_token, "la reemision debe entregar un token distinto"

    # El QR viejo ya no existe para el sistema.
    assert client.post("/tickets/preview", json={"raw_token": old_token}).status_code == 404
    # El nuevo si.
    assert client.post("/tickets/preview", json={"raw_token": new_token}).status_code == 200

    # Y la puerta redime con el token nuevo.
    assert _redeem(client, s, new_token).json()["code"] == "GRANTED"


def test_reissue_does_not_consume_extra_quota_or_capacity(client, dbcur):
    """Reemitir recupera la MISMA boleta: ni un cupo mas ni un aforo mas.

    Si la reemision emitiera una boleta nueva, el invitado quedaria con dos
    entradas y el cupo del promotor se gastaria dos veces.
    """
    s = _seed(dbcur, "reissue-cupo", capacity=100)
    ticket_id, _ = _issue(client, s)
    ptok = _token(s["p1"], s["venue_id"], "promotor")

    before = client.get(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/allocations",
        headers={"Authorization": f"Bearer {_token(s['admin_id'], s['venue_id'], 'admin')}"},
    ).json()[0]["issued"]

    for _ in range(2):
        r = client.post(
            f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets/{ticket_id}/reissue",
            headers={"Authorization": f"Bearer {ptok}"},
            json={},
        )
        assert r.status_code == 200, r.text

    after = client.get(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/allocations",
        headers={"Authorization": f"Bearer {_token(s['admin_id'], s['venue_id'], 'admin')}"},
    ).json()[0]["issued"]

    assert before == after == 1, f"el cupo cambio con la reemision: {before} -> {after}"

    dbcur.execute(
        "SELECT count(*) AS n FROM tickets WHERE event_id=%s", (s["event_id"],)
    )
    assert dbcur.fetchone()["n"] == 1, "la reemision creo una boleta nueva"


def test_reissue_logs_audit_trail(client, dbcur):
    """Debe quedar rastro de quien roto el token: soporte pregunta 'mi QR viejo
    ya no sirve' y hay que poder responder sin guardar el token crudo."""
    s = _seed(dbcur, "reissue-auditoria")
    ticket_id, old_token = _issue(client, s)
    ptok = _token(s["p1"], s["venue_id"], "promotor")

    client.post(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets/{ticket_id}/reissue",
        headers={"Authorization": f"Bearer {ptok}"},
        json={"reason": "reenvio"},
    )

    dbcur.execute(
        "SELECT reissued_by_user_id, old_token_hash, new_token_hash, reason "
        "FROM ticket_reissues WHERE ticket_id=%s ORDER BY id DESC LIMIT 1",
        (ticket_id,),
    )
    row = dbcur.fetchone()
    assert row is not None, "no quedo auditoria de la reemision"
    assert row["reissued_by_user_id"] == s["p1"]
    assert row["reason"] == "reenvio"
    # El hash viejo registrado debe ser el de la boleta original, y nunca el crudo.
    dbcur.execute(
        "SELECT encode(digest(%s,'sha256'),'hex') AS h", (old_token,)
    )
    assert row["old_token_hash"] == dbcur.fetchone()["h"]
    assert old_token not in (row["old_token_hash"], row["new_token_hash"])


def test_reissue_forbidden_for_another_promoters_ticket(client, dbcur):
    """Un promotor no puede rotar el QR de una boleta ajena: podria quedarse con
    la entrada del invitado de otro, o invalidarsela."""
    s = _seed(dbcur, "reissue-ajena")
    ticket_id, _ = _issue(client, s, "p1")

    p2tok = _token(s["p2"], s["venue_id"], "promotor")
    r = client.post(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets/{ticket_id}/reissue",
        headers={"Authorization": f"Bearer {p2tok}"},
        json={},
    )
    assert r.status_code == 403, r.text


def test_reissue_allowed_for_admin(client, dbcur):
    """El admin si puede reimprimir cualquier boleta del evento (soporte en la
    puerta: el invitado llega sin QR y alguien tiene que resolverlo)."""
    s = _seed(dbcur, "reissue-admin")
    ticket_id, _ = _issue(client, s, "p1")

    atok = _token(s["admin_id"], s["venue_id"], "admin")
    r = client.post(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets/{ticket_id}/reissue",
        headers={"Authorization": f"Bearer {atok}"},
        json={},
    )
    assert r.status_code == 200, r.text


def test_reissue_rejects_redeemed_ticket(client, dbcur):
    """Una boleta ya usada no se reemite: seria regalar una segunda entrada."""
    s = _seed(dbcur, "reissue-usada")
    ticket_id, raw = _issue(client, s)
    assert _redeem(client, s, raw).json()["code"] == "GRANTED"

    ptok = _token(s["p1"], s["venue_id"], "promotor")
    r = client.post(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets/{ticket_id}/reissue",
        headers={"Authorization": f"Bearer {ptok}"},
        json={},
    )
    assert r.status_code == 409, r.text
    assert "usada" in r.json()["detail"].lower()


def test_reissue_rejects_voided_ticket(client, dbcur):
    """Anulada: reemitirla la reviviria, saltandose la anulacion."""
    s = _seed(dbcur, "reissue-anulada")
    ticket_id, _ = _issue(client, s)
    atok = _token(s["admin_id"], s["venue_id"], "admin")
    dbcur.execute("SELECT void_ticket(%s, %s, %s)", (ticket_id, "prueba", s["admin_id"]))

    r = client.post(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets/{ticket_id}/reissue",
        headers={"Authorization": f"Bearer {atok}"},
        json={},
    )
    assert r.status_code == 409, r.text


def test_reissue_404_for_ticket_of_another_event(client, dbcur):
    """El event_id de la ruta debe mandar: no se reemite una boleta de otro
    evento colandola por una URL que no le corresponde."""
    s = _seed(dbcur, "reissue-otro-evento")
    ticket_id, _ = _issue(client, s)

    dbcur.execute(
        "INSERT INTO events (venue_id, name, starts_at, capacity, status) "
        "VALUES (%s, 'Evento vecino', now() + interval '5 days', 50, 'published') RETURNING id",
        (s["venue_id"],),
    )
    other_event = dbcur.fetchone()["id"]

    atok = _token(s["admin_id"], s["venue_id"], "admin")
    r = client.post(
        f"/venues/{s['venue_id']}/events/{other_event}/tickets/{ticket_id}/reissue",
        headers={"Authorization": f"Bearer {atok}"},
        json={},
    )
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# Listado de boletas propias
# ---------------------------------------------------------------------------
def test_promoter_lists_only_own_tickets(client, dbcur):
    """El promotor ahora puede listar, pero SOLO lo suyo: el listado era
    admin-only y por eso no tenia forma de encontrar la boleta perdida."""
    s = _seed(dbcur, "lista-propia")
    mine_id, _ = _issue(client, s, "p1")
    other_id, _ = _issue(client, s, "p2")

    p1tok = _token(s["p1"], s["venue_id"], "promotor")
    r = client.get(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets",
        headers={"Authorization": f"Bearer {p1tok}"},
    )
    assert r.status_code == 200, r.text
    # Mig Fase-2: el listado es paginado ({total, items[]})
    ids = [t["id"] for t in r.json()["items"]]
    assert mine_id in ids, "el promotor no ve su propia boleta"
    assert other_id not in ids, "el promotor no debe ver boletas ajenas"


def test_admin_lists_all_tickets(client, dbcur):
    """El staff sigue viendo todo el evento."""
    s = _seed(dbcur, "lista-admin")
    a_id, _ = _issue(client, s, "p1")
    b_id, _ = _issue(client, s, "p2")

    atok = _token(s["admin_id"], s["venue_id"], "admin")
    r = client.get(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets",
        headers={"Authorization": f"Bearer {atok}"},
    )
    assert r.status_code == 200, r.text
    ids = [t["id"] for t in r.json()["items"]]
    assert a_id in ids and b_id in ids


def test_bouncer_cannot_list_tickets(client, dbcur):
    """El bouncer no listaba antes y no debe listar: su vista es el escaner.

    El rol se asigna en la DB a proposito: `get_current_user` re-verifica los
    roles contra `venue_user_roles` en cada request, asi que un JWT con el claim
    falsificado no alcanza para probar permisos.
    """
    s = _seed(dbcur, "lista-bouncer")
    _issue(client, s, "p1")

    dbcur.execute(
        "INSERT INTO users (email, password_hash, full_name) VALUES (%s, 'x', %s) "
        "ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id",
        ("bouncer-lista-bouncer@test", "Bouncer lista-bouncer"),
    )
    bouncer_id = dbcur.fetchone()["id"]
    dbcur.execute(
        "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, 'bouncer') "
        "ON CONFLICT DO NOTHING",
        (s["venue_id"], bouncer_id),
    )

    btok = _token(bouncer_id, s["venue_id"], "bouncer")
    r = client.get(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets",
        headers={"Authorization": f"Bearer {btok}"},
    )
    assert r.status_code == 403, r.text


def test_phone_search_finds_ticket_with_uneven_format(client, dbcur):
    """La doc prometia `boletas?phone=...`. El telefono puede estar guardado con
    +, espacios o guiones; la busqueda normaliza a digitos en ambos lados."""
    s = _seed(dbcur, "buscar-telefono")
    ticket_id, _ = _issue(client, s, "p1")  # se guarda como 573001234567
    dbcur.execute(
        "UPDATE tickets SET customer_phone=%s WHERE id=%s", ("+57 300 123-4567", ticket_id)
    )

    ptok = _token(s["p1"], s["venue_id"], "promotor")
    r = client.get(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets?phone=3001234567",
        headers={"Authorization": f"Bearer {ptok}"},
    )
    assert r.status_code == 200, r.text
    assert [t["id"] for t in r.json()["items"]] == [ticket_id], "el filtro por telefono no encontro la boleta"


def test_phone_search_respects_ownership(client, dbcur):
    """Buscar por telefono no debe ser una puerta trasera para ver lo ajeno."""
    s = _seed(dbcur, "buscar-ajena")
    _issue(client, s, "p2")

    p1tok = _token(s["p1"], s["venue_id"], "promotor")
    r = client.get(
        f"/venues/{s['venue_id']}/events/{s['event_id']}/tickets?phone=573001234567",
        headers={"Authorization": f"Bearer {p1tok}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 0 and body["items"] == [], "el promotor no debe encontrar boletas ajenas por telefono"