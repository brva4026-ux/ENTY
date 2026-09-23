"""Tests de la lista de espera (mig 022, E2 del ciclo DICE).

El flujo que se protege: evento AGOTADO -> el fan entra a la fila sin
cuentas (telefono = identidad, token crudo = credencial) -> alguien devuelve
una boleta (E1) -> el lugar se ofrece al PRIMERO con ventana corta -> si no
reclama, hereda al siguiente -> reclamar EMITE una boleta nueva (nunca
revive el token devuelto).
"""
from datetime import datetime, timedelta, timezone

from tests.test_api_ticket_return import _hash  # espejo del SHA-256 hex


def _seed_sold_out(db) -> dict:
    """Evento publicado AGOTADO (activas == min(suma tipos, aforo)) con un
    cupo de promotor de 1 ya consumido por la unica boleta."""
    import uuid

    from app.core.security import hash_password

    tag = uuid.uuid4().hex[:8]
    vid = db.execute(
        "INSERT INTO venues (name, slug) VALUES (%s, %s) RETURNING id",
        (f"Venue WL {tag}", f"venue-wl-{tag}"),
    ).fetchone()["id"]
    promo = db.execute(
        "INSERT INTO users (email, password_hash, full_name) VALUES (%s, %s, 'Promo WL') RETURNING id",
        (f"promo-wl-{tag}@example.test", hash_password("test-password-123")),
    ).fetchone()["id"]
    db.execute(
        "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, 'promotor')",
        (vid, promo),
    )
    event = db.execute(
        """
        INSERT INTO events (venue_id, name, starts_at, capacity, status,
                            qr_unlock_minutes, waitlist_offer_minutes)
        VALUES (%s, %s, now() + interval '29 hours', 1, 'published', 60, 10)
        RETURNING id
        """,
        (vid, f"Evento WL {tag}"),
    ).fetchone()["id"]
    ttype = db.execute(
        """
        INSERT INTO ticket_types (event_id, name, price_cents, quantity,
                                  is_courtesy)
        VALUES (%s, 'Cortesia', 0, 1, TRUE) RETURNING id
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
        "promoter": promo,
        "event": event,
        "type": ttype,
        "allocation": alloc,
    }


def _emit_sold(db, s: dict, raw: str) -> int:
    """La boleta que agota el evento (cupo 1 de capacidad 1)."""
    return db.execute(
        "SELECT emit_ticket(%s, %s, %s, %s, 'Comprador', %s, '3001110000', NULL)",
        (s["event"], s["type"], s["allocation"], s["promoter"], raw),
    ).fetchone()["emit_ticket"]


def _join(db, s: dict, name: str, phone: str, raw: str) -> int:
    return db.execute(
        "SELECT join_waitlist(%s, %s, %s, %s)",
        (s["event"], name, phone, raw),
    ).fetchone()["join_waitlist"]


def _cleanup(db, s: dict) -> None:
    db.execute("DELETE FROM event_waitlist WHERE event_id=%s", (s["event"],))
    db.execute("DELETE FROM tickets WHERE event_id=%s", (s["event"],))
    db.execute("DELETE FROM notifications WHERE venue_id=%s", (s["venue"],))
    db.execute("DELETE FROM promoter_allocations WHERE event_id=%s", (s["event"],))
    db.execute("DELETE FROM events WHERE id=%s", (s["event"],))
    db.execute("DELETE FROM venues WHERE id=%s", (s["venue"],))
    db.execute("DELETE FROM users WHERE id=%s", (s["promoter"],))


# ===========================================================================
# Nivel DB
# ===========================================================================


def test_join_gate_and_positions(db):
    """El gate DICE: con lugar libre no hay fila; agotado, la fila ordena por
    llegada y el re-join es idempotente por telefono."""
    s = _seed_sold_out(db)
    try:
        raw_t = "token-boleta-agota-evento-1"
        _emit_sold(db, s, raw_t)

        # Agotado: activas (1) == min(tipos 1, aforo 1). El join funciona.
        p1 = _join(db, s, "Fan Uno", "3000000001", "token-fan-uno-123456")
        assert p1 == 1
        p2 = _join(db, s, "Fan Dos", "3000000002", "token-fan-dos-123456")
        assert p2 == 2

        # Re-join mismo telefono: NO duplica y devuelve su posicion.
        assert db.execute(
            "SELECT join_waitlist(%s, %s, %s, %s)",
            (s["event"], "Fan Uno Nuevo", "3000000001", "token-otro-xyz-12345"),
        ).fetchone()["join_waitlist"] == 1
        assert db.execute(
            "SELECT count(*) AS n FROM event_waitlist WHERE event_id=%s",
            (s["event"],),
        ).fetchone()["n"] == 2
        # Con lugar libre el gate rechaza: devolver la unica boleta abre
        # cupo y el join de un tercero muere con waitlist_not_needed...
        # PERO return_ticket re-ofrece al primero, asi que probamos el gate
        # directo desactivando la fila: anular SIN return (void de staff).
        db.execute(
            """
            UPDATE tickets SET status='voided', voided_at=now()
             WHERE token_hash = encode(digest(%s,'sha256'),'hex')
            """,
            (raw_t,),
        )
        try:
            _join(db, s, "Fan Tres", "3000000003", "token-fan-tres-123456")
            gate_raised = False
        except Exception as e:
            gate_raised = "waitlist_not_needed" in str(e)
        assert gate_raised, "con lugar libre la lista no debe aceptar gente"
    finally:
        _cleanup(db, s)


def test_return_offers_first_and_claim_emits_new_ticket(db):
    """E1 -> E2: devolver ofrece al primero; reclamar emite boleta NUEVA con
    el telefono del fan y consume su credencial."""
    s = _seed_sold_out(db)
    try:
        raw_t = "token-boleta-agota-evento-2"
        t1 = _emit_sold(db, s, raw_t)
        _join(db, s, "Fan Uno", "3000000001", "token-fan-uno-123456")
        _join(db, s, "Fan Dos", "3000000002", "token-fan-dos-123456")

        # El comprador devuelve su boleta (E1): la fila se mueve sola.
        db.execute("SELECT return_ticket(%s, %s, NULL)", (t1, _hash(raw_t)))

        assert db.execute(
            "SELECT status::text AS s FROM event_waitlist WHERE phone='3000000001'"
        ).fetchone()["s"] == "offered"
        assert db.execute(
            "SELECT status::text AS s FROM event_waitlist WHERE phone='3000000002'"
        ).fetchone()["s"] == "waiting"

        # El primero reclama: boleta NUEVA a su nombre y telefono.
        raw_new = "token-boleta-reclamada-fan1"
        new_id = db.execute(
            "SELECT claim_waitlist(%s, %s)",
            (_hash("token-fan-uno-123456"), raw_new),
        ).fetchone()["claim_waitlist"]
        assert new_id != t1

        row = db.execute(
            "SELECT customer_name, customer_phone, status::text AS s FROM tickets WHERE id=%s",
            (new_id,),
        ).fetchone()
        assert row["customer_name"] == "Fan Uno"
        assert row["customer_phone"] == "3000000001"
        assert row["s"] == "issued"

        # El token DEVUELTO no revive: la boleta t1 sigue muerta.
        assert db.execute(
            "SELECT status::text AS s FROM tickets WHERE id=%s", (t1,)
        ).fetchone()["s"] == "voided"

        # La credencial del fan 1 ya no sirve (status claimed).
        assert db.execute(
            "SELECT status::text AS s FROM event_waitlist WHERE phone='3000000001'"
        ).fetchone()["s"] == "claimed"

        # Y la fila hereda: Fan Dos sigue esperando; si el comprador original
        # "reclamara" con su credencial vieja, no existe oferta para el.
        old_raised = False
        try:
            db.execute(
                "SELECT claim_waitlist(%s, %s)",
                (_hash(raw_t), "token-intento-con-viejo"),
            ).fetchone()
        except Exception as e:
            old_raised = "waitlist_offer_expired" in str(e) or "not found" in str(e).lower()
        assert old_raised, "la credencial del token devuelto no debe servir"
    finally:
        _cleanup(db, s)


def test_offer_expires_and_inherits(db):
    """Si el primero no reclama en la ventana, expira y el siguiente recibe
    LA MISMA oferta (tipo y cupo heredados)."""
    s = _seed_sold_out(db)
    try:
        raw_t = "token-boleta-agota-evento-3"
        t1 = _emit_sold(db, s, raw_t)
        _join(db, s, "Fan Uno", "3000000001", "token-fan-uno-123456")
        _join(db, s, "Fan Dos", "3000000002", "token-fan-dos-123456")

        db.execute("SELECT return_ticket(%s, %s, NULL)", (t1, _hash(raw_t)))

        # Forzar el vencimiento: offered_at en el pasado.
        db.execute(
            "UPDATE event_waitlist SET offered_at = now() - interval '1 hour' "
            "WHERE phone='3000000001'"
        )

        # El watchdog perezoso expira y hereda.
        expired = db.execute("SELECT expire_waitlist_offers()").fetchone()[
            "expire_waitlist_offers"
        ]
        assert expired == 1

        row = db.execute(
            "SELECT status::text AS s, offered_ticket_type_id AS tt, "
            "offered_allocation_id AS al FROM event_waitlist WHERE phone='3000000001'"
        ).fetchone()
        assert row["s"] == "expired"
        row = db.execute(
            "SELECT status::text AS s, offered_ticket_type_id AS tt, "
            "offered_allocation_id AS al FROM event_waitlist WHERE phone='3000000002'"
        ).fetchone()
        assert row["s"] == "offered"
        # La oferta heredada es la MISMA (mismo tipo, mismo cupo).
        assert row["tt"] == s["type"]
        assert row["al"] == s["allocation"]

        # El heredero SI puede reclamar.
        claimed = db.execute(
            "SELECT claim_waitlist(%s, %s)",
            (_hash("token-fan-dos-123456"), "token-boleta-reclamada-fan2"),
        ).fetchone()["claim_waitlist"]
        assert claimed > 0
    finally:
        _cleanup(db, s)


def test_leave_inherits_offer(db):
    """Salir con oferta activa hereda el turno al siguiente."""
    s = _seed_sold_out(db)
    try:
        raw_t = "token-boleta-agota-evento-4"
        t1 = _emit_sold(db, s, raw_t)
        _join(db, s, "Fan Uno", "3000000001", "token-fan-uno-123456")
        _join(db, s, "Fan Dos", "3000000002", "token-fan-dos-123456")

        db.execute("SELECT return_ticket(%s, %s, NULL)", (t1, _hash(raw_t)))

        # Fan Uno (ofertado) se va: el turno pasa a Fan Dos con el mismo lugar.
        db.execute("SELECT leave_waitlist(%s)", (_hash("token-fan-uno-123456"),))

        assert db.execute(
            "SELECT status::text AS s FROM event_waitlist WHERE phone='3000000001'"
        ).fetchone()["s"] == "left"
        assert db.execute(
            "SELECT status::text AS s FROM event_waitlist WHERE phone='3000000002'"
        ).fetchone()["s"] == "offered"
    finally:
        _cleanup(db, s)


# ===========================================================================
# Nivel API
# ===========================================================================


def test_api_join_status_claim_flow(api_client, db, dbcur):
    """Ciclo HTTP completo: join agotado -> devolucion -> status muestra la
    oferta con countdown -> claim entrega boleta nueva -> status claimed."""
    client = api_client
    s = _seed_sold_out(db)
    try:
        raw_t = "token-boleta-agota-evento-5"
        _emit_sold(db, s, raw_t)

        res = client.post(
            f"/waitlist/{s['event']}/join",
            json={"name": "Fan API", "phone": "3007770001"},
        )
        assert res.status_code == 201, res.text
        d = res.json()
        assert d["position"] == 1
        assert d["token"], "el primer join debe entregar la credencial"
        fan_token = d["token"]

        # Sin credencial no hay estado.
        res = client.post("/waitlist/status", json={"token": "no-existo-12345"})
        assert res.status_code == 404

        # El comprador devuelve; el API del fan muestra la oferta.
        dbcur.execute(
            "SELECT id FROM tickets WHERE token_hash = encode(digest(%s,'sha256'),'hex')",
            (raw_t,),
        )
        t1 = dbcur.fetchone()["id"]
        dbcur.execute("SELECT return_ticket(%s, %s, NULL)", (t1, _hash(raw_t)))
        dbcur.fetchone()

        res = client.post("/waitlist/status", json={"token": fan_token})
        assert res.status_code == 200, res.text
        d = res.json()
        assert d["status"] == "offered"
        assert d["offer_seconds_left"] > 0
        assert d["offer_expires_at"]

        # Reclamar: boleta nueva, token de una sola vez.
        res = client.post("/waitlist/claim", json={"token": fan_token})
        assert res.status_code == 200, res.text
        d = res.json()
        assert d["status"] == "claimed"
        assert d["raw_token"]
        ticket_id = d["ticket_id"]

        dbcur.execute(
            "SELECT customer_name, customer_phone FROM tickets WHERE id=%s",
            (ticket_id,),
        )
        row = dbcur.fetchone()
        assert row["customer_name"] == "Fan API"
        assert row["customer_phone"] == "3007770001"

        # Su credencial de fila murio con el reclamo.
        res = client.post("/waitlist/claim", json={"token": fan_token})
        assert res.status_code == 409

        res = client.post("/waitlist/status", json={"token": fan_token})
        assert res.status_code == 200
        assert res.json()["status"] == "claimed"
    finally:
        _cleanup(db, s)


def test_api_gate_open_event_rejected(api_client, db):
    """Un evento con lugar libre rechaza el join con 409 claro."""
    client = api_client
    s = _seed_sold_out(db)
    try:
        # SIN boletas emitidas: hay lugar (0 < min(1,1)).
        res = client.post(
            f"/waitlist/{s['event']}/join",
            json={"name": "Fan Temprano", "phone": "3007770002"},
        )
        assert res.status_code == 409
        assert "no hay lista" in res.json()["detail"].lower()
    finally:
        _cleanup(db, s)


def test_api_leave(api_client, db, dbcur):
    """Salir por la propia credencial deja la fila limpia."""
    client = api_client
    s = _seed_sold_out(db)
    try:
        raw_t = "token-boleta-agota-evento-6"
        _emit_sold(db, s, raw_t)
        res = client.post(
            f"/waitlist/{s['event']}/join",
            json={"name": "Fan Se Va", "phone": "3007770003"},
        )
        fan_token = res.json()["token"]

        res = client.post("/waitlist/leave", json={"token": fan_token})
        assert res.status_code == 200, res.text

        dbcur.execute(
            "SELECT status::text AS s FROM event_waitlist WHERE phone='3007770003'"
        )
        assert dbcur.fetchone()["s"] == "left"

        # Su credencial ya no consulta estado util.
        res = client.post("/waitlist/status", json={"token": fan_token})
        assert res.status_code == 200
        assert res.json()["status"] == "left"
    finally:
        _cleanup(db, s)
