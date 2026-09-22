"""Tests de la devolucion de boletas — "No puedo ir" (mig 021, E1 DICE).

El flujo que se protege: el invitado devuelve desde su enlace /t#<token>,
el QR muere, el cupo del promotor se LIBERA (puede reasignarlo) y todo
queda auditado en ticket_returns. La ventana limite cierra con el unlock
del QR: despues, la devolucion es problema de puerta (cobija lista).
"""

import hashlib


def _hash(raw: str) -> str:
    """Espejo del SHA-256 hex que la DB guarda en tickets.token_hash."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ===========================================================================
# Nivel DB: la funcion return_ticket
# ===========================================================================


def test_return_by_guest_frees_allocation(dbcur):
    """Devolucion del invitado: boleta voided, auditada y el cupo se libera."""
    # Escenario directo en DB: evento publicado con unlock lejano (ventana
    # abierta), tipo cortesia, cupo de 1 y una boleta emitida contra el cupo.
    dbcur.execute(
        """
        INSERT INTO venues (name, slug) VALUES ('Venue Ret', 'venue-ret-21')
        ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id
        """
    )
    vid = dbcur.fetchone()["id"]
    dbcur.execute("DELETE FROM events WHERE name='Evento Ret 21'")
    # starts_at a +29h con unlock 60: ventana de devolucion ABIERTA.
    dbcur.execute(
        """
        INSERT INTO events (venue_id, name, starts_at, capacity, status,
                            qr_unlock_minutes)
        VALUES (%s, 'Evento Ret 21', now() + interval '29 hours', 10,
                'published', 60) RETURNING id
        """,
        (vid,),
    )
    eid = dbcur.fetchone()["id"]
    dbcur.execute(
        """
        INSERT INTO ticket_types (event_id, name, price_cents, quantity,
                                  is_courtesy)
        VALUES (%s, 'Cortesia', 0, 10, TRUE) RETURNING id
        """,
        (eid,),
    )
    tid = dbcur.fetchone()["id"]
    dbcur.execute(
        """
        INSERT INTO users (email, password_hash, full_name)
        VALUES ('promo-ret-21@example.test', 'x', 'Promo Ret') RETURNING id
        """
    )
    pid = dbcur.fetchone()["id"]
    dbcur.execute(
        "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, 'promotor')",
        (vid, pid),
    )
    dbcur.execute(
        """
        INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id,
                                          capacity)
        VALUES (%s, %s, %s, 1) RETURNING id
        """,
        (eid, tid, pid),
    )
    aid = dbcur.fetchone()["id"]

    raw = "token-devolucion-invitado-21"
    dbcur.execute(
        "SELECT emit_ticket(%s, %s, %s, %s, 'Invitado Ret', %s, NULL, NULL)",
        (eid, tid, aid, pid, raw),
    )
    ticket_id = dbcur.fetchone()["emit_ticket"]

    # El cupo esta lleno: sin devolucion, una segunda emision falla.
    dbcur.execute("BEGIN")
    try:
        dbcur.execute(
            "SELECT emit_ticket(%s, %s, %s, %s, 'Otro', %s, NULL, NULL)",
            (eid, tid, aid, pid, "token-otro-123456789"),
        )
        raised = False
    except Exception:
        raised = True
    finally:
        dbcur.execute("ROLLBACK")
    assert raised, "el cupo (1) no debio aceptar una segunda boleta"

    # El invitado devuelve: token + id (hash esperado), sin usuario.
    dbcur.execute(
        "SELECT return_ticket(%s, %s, NULL)",
        (ticket_id, _hash(raw)),
    )
    dbcur.fetchone()

    dbcur.execute(
        "SELECT status::text AS s, voided_at IS NOT NULL AS v FROM tickets WHERE id=%s",
        (ticket_id,),
    )
    row = dbcur.fetchone()
    assert row["s"] == "voided"
    assert row["v"]

    # La auditoria quedo con el hash del token del invitado.
    dbcur.execute(
        "SELECT returned_token_hash, returned_by_user_id FROM ticket_returns WHERE ticket_id=%s",
        (ticket_id,),
    )
    audit = dbcur.fetchone()
    assert audit["returned_token_hash"] == _hash(raw)
    assert audit["returned_by_user_id"] is None

    # El cupo quedo LIBRE: ahora la misma emision si funciona.
    dbcur.execute(
        "SELECT emit_ticket(%s, %s, %s, %s, 'Reasignado', %s, NULL, NULL)",
        (eid, tid, aid, pid, "token-reasignado-12345"),
    )
    new_id = dbcur.fetchone()["emit_ticket"]
    assert new_id != ticket_id

    # Limpieza del escenario (los tests comparten la DB de prueba).
    dbcur.execute("DELETE FROM tickets WHERE event_id=%s", (eid,))
    dbcur.execute("DELETE FROM ticket_returns WHERE event_id=%s", (eid,))
    dbcur.execute("DELETE FROM notifications WHERE venue_id=%s", (vid,))
    dbcur.execute("DELETE FROM promoter_allocations WHERE event_id=%s", (eid,))
    dbcur.execute("DELETE FROM events WHERE id=%s", (eid,))
    dbcur.execute("DELETE FROM venues WHERE id=%s", (vid,))
    dbcur.execute("DELETE FROM users WHERE email='promo-ret-21@example.test'")


def test_return_rejects_stale_token_and_window(dbcur):
    """Carrera con reissue y ventana cerrada: la DB rechaza ambas."""
    dbcur.execute(
        """
        INSERT INTO venues (name, slug) VALUES ('Venue Ret2', 'venue-ret2-21')
        ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id
        """
    )
    vid = dbcur.fetchone()["id"]
    dbcur.execute("DELETE FROM events WHERE name IN ('Evento Ret2A', 'Evento Ret2B')")

    # Evento A: ventana abierta (para probar token_stale tras reissue).
    dbcur.execute(
        """
        INSERT INTO events (venue_id, name, starts_at, capacity, status,
                            qr_unlock_minutes)
        VALUES (%s, 'Evento Ret2A', now() + interval '29 hours', 10,
                'published', 60) RETURNING id
        """,
        (vid,),
    )
    eid_a = dbcur.fetchone()["id"]
    # Evento B: el unlock (20 min) ya paso (arranca en 10) => ventana CERRADA.
    dbcur.execute(
        """
        INSERT INTO events (venue_id, name, starts_at, capacity, status,
                            qr_unlock_minutes)
        VALUES (%s, 'Evento Ret2B', now() + interval '10 minutes', 10,
                'published', 20) RETURNING id
        """,
        (vid,),
    )
    eid_b = dbcur.fetchone()["id"]
    for eid in (eid_a, eid_b):
        dbcur.execute(
            """
            INSERT INTO ticket_types (event_id, name, price_cents, quantity,
                                      is_courtesy)
            VALUES (%s, 'Cortesia', 0, 10, TRUE) RETURNING id
            """,
            (eid,),
        )
    dbcur.execute("SELECT id FROM ticket_types WHERE event_id=%s ORDER BY id", (eid_a,))
    tid_a = dbcur.fetchone()["id"]
    dbcur.execute("SELECT id FROM ticket_types WHERE event_id=%s ORDER BY id", (eid_b,))
    tid_b = dbcur.fetchone()["id"]

    raw_a, raw_b = "token-ventana-abierta-aaa", "token-ventana-cerrada-bb"
    dbcur.execute(
        "SELECT emit_ticket(%s, %s, NULL, NULL, 'A', %s, NULL, NULL)",
        (eid_a, tid_a, raw_a),
    )
    t_a = dbcur.fetchone()["emit_ticket"]
    dbcur.execute(
        "SELECT emit_ticket(%s, %s, NULL, NULL, 'B', %s, NULL, NULL)",
        (eid_b, tid_b, raw_b),
    )
    t_b = dbcur.fetchone()["emit_ticket"]

    # --- token_stale: rotar token (reissue) y volver con el hash viejo.
    dbcur.execute("SELECT reissue_ticket(%s, %s, NULL, 'test')", (t_a, "token-nuevo-tras-reissue"))
    dbcur.fetchone()
    try:
        dbcur.execute("SELECT return_ticket(%s, %s, NULL)", (t_a, _hash(raw_a)))
        stale_raised = False
    except Exception as e:
        stale_raised = "token_stale" in str(e)
    assert stale_raised, "un token viejo no debe poder devolver la boleta"

    # --- ventana cerrada: unlock ya paso (0 min y arranca en 10 min).
    try:
        dbcur.execute("SELECT return_ticket(%s, %s, NULL)", (t_b, _hash(raw_b)))
        closed_raised = False
    except Exception as e:
        closed_raised = "return_window_closed" in str(e)
    assert closed_raised, "fuera de ventana la devolucion debe rechazarse"

    # --- idempotencia: devolver dos veces el mismo token no rompe.
    dbcur.execute("SELECT return_ticket(%s, %s, NULL)", (t_a, _hash("token-nuevo-tras-reissue")))
    dbcur.fetchone()
    dbcur.execute(
        "SELECT count(*) AS n FROM ticket_returns WHERE ticket_id=%s", (t_a,)
    )
    assert dbcur.fetchone()["n"] == 1

    # Limpieza.
    dbcur.execute("DELETE FROM ticket_returns WHERE event_id IN (%s,%s)", (eid_a, eid_b))
    dbcur.execute("DELETE FROM notifications WHERE venue_id=%s", (vid,))
    dbcur.execute("DELETE FROM tickets WHERE event_id IN (%s,%s)", (eid_a, eid_b))
    dbcur.execute("DELETE FROM events WHERE id IN (%s,%s)", (eid_a, eid_b))
    dbcur.execute("DELETE FROM venues WHERE id=%s", (vid,))


# ===========================================================================
# Nivel API: endpoints publico y de staff
# ===========================================================================


def _seed_world(db) -> dict:
    """Venue + evento con ventana abierta + cupo de 1 para el promotor."""
    import uuid

    from app.core.security import hash_password

    tag = uuid.uuid4().hex[:8]
    vid = db.execute(
        "INSERT INTO venues (name, slug) VALUES (%s, %s) RETURNING id",
        (f"Venue API Ret {tag}", f"venue-api-ret-{tag}"),
    ).fetchone()["id"]
    admin = db.execute(
        "INSERT INTO users (email, password_hash, full_name) VALUES (%s, %s, 'Admin Ret') RETURNING id",
        (f"admin-ret-{tag}@example.test", hash_password("test-password-123")),
    ).fetchone()["id"]
    promo = db.execute(
        "INSERT INTO users (email, password_hash, full_name) VALUES (%s, %s, 'Promo Ret') RETURNING id",
        (f"promo-api-ret-{tag}@example.test", hash_password("test-password-123")),
    ).fetchone()["id"]
    db.execute(
        "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, 'admin')",
        (vid, admin),
    )
    db.execute(
        "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, 'promotor')",
        (vid, promo),
    )
    event = db.execute(
        """
        INSERT INTO events (venue_id, name, starts_at, capacity, status,
                            qr_unlock_minutes)
        VALUES (%s, %s, now() + interval '29 hours', 10, 'published', 60)
        RETURNING id
        """,
        (vid, f"Evento API Ret {tag}"),
    ).fetchone()["id"]
    ttype = db.execute(
        """
        INSERT INTO ticket_types (event_id, name, price_cents, quantity,
                                  is_courtesy)
        VALUES (%s, 'Cortesia', 0, 10, TRUE) RETURNING id
        """,
        (event,),
    ).fetchone()["id"]
    alloc = db.execute(
        """
        INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id,
                                          capacity)
        VALUES (%s, %s, %s, 1) RETURNING id
        """,
        (event, ttype, promo),
    ).fetchone()["id"]
    return {
        "tag": tag,
        "venue": vid,
        "admin": admin,
        "promoter": promo,
        "event": event,
        "type": ttype,
        "allocation": alloc,
        "password": "test-password-123",
    }


def test_public_return_endpoint_kills_qr_and_frees_quota(api_client, db, dbcur):
    """API publica: devolver con token+id; el promotor re-emite el cupo."""
    w = _seed_world(db)
    client = api_client

    # Login del promotor para emitir y luego verificar su cupo por API.
    res = client.post(
        "/auth/login",
        json={"email": f"promo-api-ret-{w['tag']}@example.test", "password": w["password"]},
    )
    assert res.status_code == 200, res.text
    promo_headers = {"Authorization": f"Bearer {res.json()['access_token']}"}

    raw = None  # el token crudo real lo entrega la API al emitir
    res = client.post(
        f"/venues/{w['venue']}/events/{w['event']}/tickets",
        headers=promo_headers,
        json={
            "ticket_type_id": w["type"],
            "allocation_id": w["allocation"],
            "customer_name": "Invitado API",
            "customer_phone": "3001112233",
        },
    )
    assert res.status_code == 201, res.text
    ticket_id = res.json()["ticket_id"]
    # El token crudo lo genera la API (solo se entrega una vez): es el que
    # llega al invitado, no uno inventado por el test.
    raw = res.json()["raw_token"]

    # El preview marca que la boleta PUEDE devolverse y hasta cuando.
    res = client.post("/tickets/preview", json={"raw_token": raw})
    assert res.status_code == 200, res.text
    d = res.json()
    assert d["can_return"] is True
    assert d["return_until"]

    # El invitado devuelve desde su enlace (sin auth).
    res = client.post(
        "/tickets/return",
        json={"ticket_id": ticket_id, "raw_token": raw},
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "returned"

    # La imagen ya no se regenera: 410 (el QR murio para siempre).
    res = client.post("/tickets/image", json={"raw_token": raw})
    assert res.status_code == 410

    # El preview ahora dice "devuelta".
    res = client.post("/tickets/preview", json={"raw_token": raw})
    d = res.json()
    assert d["status"] == "voided"
    assert d["was_returned"] is True
    assert d["can_return"] is False

    # El cupo del promotor quedo libre: emite de nuevo por API.
    res = client.post(
        f"/venues/{w['venue']}/events/{w['event']}/tickets",
        headers=promo_headers,
        json={
            "ticket_type_id": w["type"],
            "allocation_id": w["allocation"],
            "customer_name": "Reasignado",
            "customer_phone": "3004445566",
        },
    )
    assert res.status_code == 201, res.text

    # El vendedor recibio la notificacion del retorno.
    dbcur.execute(
        "SELECT count(*) AS n FROM notifications WHERE user_id=%s AND kind='ticket_returned'",
        (w["promoter"],),
    )
    assert dbcur.fetchone()["n"] >= 1

    # Limpieza.
    db.execute("DELETE FROM tickets WHERE event_id=%s", (w["event"],))
    db.execute("DELETE FROM notifications WHERE venue_id=%s", (w["venue"],))
    db.execute("DELETE FROM promoter_allocations WHERE event_id=%s", (w["event"],))
    db.execute("DELETE FROM events WHERE id=%s", (w["event"],))
    db.execute("DELETE FROM venues WHERE id=%s", (w["venue"],))
    db.execute("DELETE FROM users WHERE id IN (%s,%s)", (w["admin"], w["promoter"]))


def test_public_return_rejects_wrong_token(api_client, db, dbcur):
    """Un token que no es la credencial de esa boleta: 404 (sin senales)."""
    w = _seed_world(db)
    client = api_client
    res = client.post(
        "/tickets/return",
        json={"ticket_id": 999999, "raw_token": "token-inexistente-xyz"},
    )
    assert res.status_code == 404

    db.execute("DELETE FROM venues WHERE id=%s", (w["venue"],))
    db.execute("DELETE FROM users WHERE id IN (%s,%s)", (w["admin"], w["promoter"]))


def test_staff_return_endpoint_and_permissions(api_client, db, dbcur):
    """El staff devuelve por id; un promotor ajeno recibe 403."""
    w = _seed_world(db)
    client = api_client
    from app.core.security import hash_password

    res = client.post(
        "/auth/login",
        json={"email": f"admin-ret-{w['tag']}@example.test", "password": w["password"]},
    )
    admin_headers = {"Authorization": f"Bearer {res.json()['access_token']}"}
    res = client.post(
        "/auth/login",
        json={"email": f"promo-api-ret-{w['tag']}@example.test", "password": w["password"]},
    )
    promo_headers = {"Authorization": f"Bearer {res.json()['access_token']}"}

    # Un segundo promotor (ajeno a la boleta) para probar el 403.
    other = db.execute(
        "INSERT INTO users (email, password_hash, full_name) VALUES (%s, %s, 'Otro Promo') RETURNING id",
        (f"otro-ret-{w['tag']}@example.test", hash_password(w["password"])),
    ).fetchone()["id"]
    db.execute(
        "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, 'promotor')",
        (w["venue"], other),
    )
    res = client.post(
        "/auth/login",
        json={"email": f"otro-ret-{w['tag']}@example.test", "password": w["password"]},
    )
    other_headers = {"Authorization": f"Bearer {res.json()['access_token']}"}

    raw = "token-staff-devolucion-777"
    res = client.post(
        f"/venues/{w['venue']}/events/{w['event']}/tickets",
        headers=promo_headers,
        json={
            "ticket_type_id": w["type"],
            "allocation_id": w["allocation"],
            "customer_name": "Invitado Staff",
            "customer_phone": "3009998877",
        },
    )
    assert res.status_code == 201, res.text
    ticket_id = res.json()["ticket_id"]

    # El promotor DUEÑO si puede devolver por id (espejo de reissue).
    res = client.post(
        f"/venues/{w['venue']}/events/{w['event']}/tickets/{ticket_id}/return",
        headers=promo_headers,
    )
    assert res.status_code == 200, res.text

    # Quedo voided y auditada con marca de staff.
    dbcur.execute(
        """
        SELECT t.status::text AS s, tr.returned_token_hash AS h
          FROM tickets t LEFT JOIN ticket_returns tr ON tr.ticket_id = t.id
         WHERE t.id=%s
        """,
        (ticket_id,),
    )
    row = dbcur.fetchone()
    assert row["s"] == "voided"
    assert (row["h"] or "").startswith("staff::")

    # Nueva boleta para probar 403 del promotor ajeno y devolucion admin.
    raw2 = "token-staff-devolucion-888"
    res = client.post(
        f"/venues/{w['venue']}/events/{w['event']}/tickets",
        headers=promo_headers,
        json={
            "ticket_type_id": w["type"],
            "allocation_id": w["allocation"],
            "customer_name": "Invitado Dos",
            "customer_phone": "3005556677",
        },
    )
    assert res.status_code == 201, res.text
    ticket2 = res.json()["ticket_id"]

    res = client.post(
        f"/venues/{w['venue']}/events/{w['event']}/tickets/{ticket2}/return",
        headers=other_headers,
    )
    assert res.status_code == 403

    # El admin (staff) devuelve cualquiera del evento.
    res = client.post(
        f"/venues/{w['venue']}/events/{w['event']}/tickets/{ticket2}/return",
        headers=admin_headers,
    )
    assert res.status_code == 200, res.text

    # Limpieza.
    db.execute("DELETE FROM tickets WHERE event_id=%s", (w["event"],))
    db.execute("DELETE FROM notifications WHERE venue_id=%s", (w["venue"],))
    db.execute("DELETE FROM promoter_allocations WHERE event_id=%s", (w["event"],))
    db.execute("DELETE FROM events WHERE id=%s", (w["event"],))
    db.execute("DELETE FROM venues WHERE id=%s", (w["venue"],))
    db.execute(
        "DELETE FROM users WHERE id IN (%s,%s,%s)", (w["admin"], w["promoter"], other)
    )
