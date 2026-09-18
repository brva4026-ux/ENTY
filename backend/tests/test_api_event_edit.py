"""Tests de la migración 005: edición de eventos (PATCH /events/{id}) y
cancelación desde published.

Nivel API: el PATCH aplica solo los campos enviados, protege el aforo con
boletas activas y rechaza estados no editables. La cancelación desde published
valida la transición vía endpoint y el trigger de DB.
"""
import secrets

import psycopg
import pytest


FUTURE_STARTS = "2099-10-01T20:00:00+00:00"
FUTURE_ENDS = "2099-10-02T02:00:00+00:00"


# ---------------------------------------------------------------------------
# PATCH /events/{id}
# ---------------------------------------------------------------------------
def test_patch_event_edits_single_field(api):
    """Un PATCH con un solo campo no toca los demás."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, description="original", capacity=100)

    res = api.patch(api.event_url(venue, ev["id"]), "admin", {"name": "Nombre nuevo"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["name"] == "Nombre nuevo"
    assert body["description"] == "original"  # intacto
    assert body["capacity"] == 100  # intacto
    assert body["status"] == "draft"


def test_patch_event_updates_dates_and_capacity(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, capacity=100)

    res = api.patch(
        api.event_url(venue, ev["id"]),
        "admin",
        {
            "starts_at": FUTURE_STARTS,
            "ends_at": FUTURE_ENDS,
            "capacity": 150,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["capacity"] == 150
    assert body["ends_at"] is not None
    assert body["starts_at"].startswith("2099-10-01")


def test_patch_event_rejects_invalid_window(api):
    """ends_at <= starts_at se rechaza (validado en Pydantic y en la DB)."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, capacity=100)

    res = api.patch(
        api.event_url(venue, ev["id"]),
        "admin",
        {"starts_at": FUTURE_ENDS, "ends_at": FUTURE_STARTS},
    )
    assert res.status_code == 422


def test_patch_event_rejects_past_starts(api):
    """No se puede mover la apertura al pasado (error de negocio de la DB)."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, capacity=100)

    res = api.patch(
        api.event_url(venue, ev["id"]),
        "admin",
        {"starts_at": "2020-01-01T20:00:00+00:00"},
    )
    assert res.status_code == 400
    assert "pasado" in res.json()["detail"].lower()


def test_patch_event_capacity_below_issued_rejected(api):
    """El aforo no puede quedar por debajo de las boletas activas emitidas."""
    venue = api.world["venue_a"]
    sc = api.scenario(capacity=50, alloc_capacity=5, type_quantity=50)
    event = sc["event"]

    # Emitir 3 boletas contra el cupo del promotor
    for i in range(3):
        api.emit(
            "promoter",
            venue,
            event,
            ticket_type_id=sc["type"],
            allocation_id=sc["allocation"]["id"],
            customer_name=f"Invitado {i}",
        )

    res = api.patch(api.event_url(venue, event), "admin", {"capacity": 2})
    assert res.status_code == 409
    assert "aforo" in res.json()["detail"].lower() or "capacidad" in res.json()["detail"].lower()

    # Subir el aforo sí pasa
    res = api.patch(api.event_url(venue, event), "admin", {"capacity": 60})
    assert res.status_code == 200
    assert res.json()["capacity"] == 60


def test_patch_event_blocked_on_live_and_ended(api):
    """Solo draft/published son editables."""
    venue = api.world["venue_a"]
    sc = api.scenario(capacity=50, alloc_capacity=5, type_quantity=50)
    event = sc["event"]

    # published -> live
    res = api.post(f"/venues/{venue}/events/{event}/live", "admin")
    assert res.status_code == 200, res.text

    res = api.patch(api.event_url(venue, event), "admin", {"name": "X"})
    assert res.status_code == 409

    # live -> ended
    res = api.post(f"/venues/{venue}/events/{event}/end", "admin")
    assert res.status_code == 200, res.text

    res = api.patch(api.event_url(venue, event), "admin", {"name": "X"})
    assert res.status_code == 409


def test_patch_event_requires_admin(api):
    """Un promotor no puede editar el evento."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, capacity=100)

    res = api.patch(api.event_url(venue, ev["id"]), "promoter", {"name": "X"})
    assert res.status_code == 403


def test_patch_event_isolated_per_venue(api):
    """El admin de otra venue no puede editar (aislamiento multi-tenant)."""
    ev = api.create_event("admin", api.world["venue_a"], capacity=100)

    res = api.patch(api.event_url(api.world["venue_b"], ev["id"]), "outsider", {"name": "X"})
    assert res.status_code in (403, 404)


def test_patch_event_404_unknown(api):
    venue = api.world["venue_a"]
    res = api.patch(api.event_url(venue, 999999), "admin", {"name": "X"})
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Cancelación desde published
# ---------------------------------------------------------------------------
def test_cancel_from_published_allowed(api):
    """Un evento publicado se puede cancelar (antes solo draft)."""
    venue = api.world["venue_a"]
    sc = api.scenario()  # publicado
    event = sc["event"]

    res = api.post(f"/venues/{venue}/events/{event}/cancel", "admin")
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"


def test_cancel_from_draft_still_allowed(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, capacity=100)

    res = api.post(f"/venues/{venue}/events/{ev['id']}/cancel", "admin")
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"


def test_cancel_rejected_for_live_ended_cancelled(api):
    """En puerta, terminado o ya cancelado no se puede cancelar."""
    venue = api.world["venue_a"]
    sc = api.scenario(capacity=50, alloc_capacity=5, type_quantity=50)
    event = sc["event"]

    res = api.post(f"/venues/{venue}/events/{event}/live", "admin")
    assert res.status_code == 200, res.text

    # live -> cancelled: bloqueado por la API y por el trigger de DB
    res = api.post(f"/venues/{venue}/events/{event}/cancel", "admin")
    assert res.status_code == 409

    res = api.post(f"/venues/{venue}/events/{event}/end", "admin")
    assert res.status_code == 200, res.text
    res = api.post(f"/venues/{venue}/events/{event}/cancel", "admin")
    assert res.status_code == 409


def test_cancelled_event_cannot_emit(api):
    """Tras cancelar, la puerta rechaza emitir boletas (emit_ticket)."""
    venue = api.world["venue_a"]
    sc = api.scenario()
    event = sc["event"]

    res = api.post(f"/venues/{venue}/events/{event}/cancel", "admin")
    assert res.status_code == 200, res.text

    with pytest.raises(AssertionError):
        api.emit(
            "promoter",
            venue,
            event,
            ticket_type_id=sc["type"],
            allocation_id=sc["allocation"]["id"],
        )


def test_cancelled_event_redeem_rejected(api):
    """Una boleta de un evento cancelado no pasa en la puerta."""
    venue = api.world["venue_a"]
    sc = api.scenario()
    event = sc["event"]

    emitted = api.emit(
        "promoter",
        venue,
        event,
        ticket_type_id=sc["type"],
        allocation_id=sc["allocation"]["id"],
    )

    res = api.post(f"/venues/{venue}/events/{event}/cancel", "admin")
    assert res.status_code == 200, res.text

    res = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "bouncer",
        {"raw_token": emitted["raw_token"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["code"] == "EVENT_NOT_LIVE"


# ---------------------------------------------------------------------------
# Trigger de DB (defensa en profundidad)
# ---------------------------------------------------------------------------
def test_db_trigger_blocks_invalid_transition(dbcur):
    """El trigger bloquea transiciones inválidas incluso por SQL directo."""
    dbcur.execute(
        "INSERT INTO venues (name, slug) VALUES ('t-trig', 't-trig') RETURNING id"
    )
    v = dbcur.fetchone()["id"]
    dbcur.execute(
        "INSERT INTO events (venue_id, name, starts_at, capacity, status) "
        "VALUES (%s, 'Trig Event', now() + interval '3 days', 10, 'draft') RETURNING id",
        (v,),
    )
    e = dbcur.fetchone()["id"]

    # draft -> ended: inválido
    with pytest.raises(psycopg.errors.RaiseException) as exc:
        dbcur.execute("UPDATE events SET status='ended' WHERE id=%s", (e,))
    assert "invalid_transition" in str(exc.value)

    # published -> cancelled: válido (nueva regla 005)
    dbcur.execute("UPDATE events SET status='published' WHERE id=%s", (e,))
    dbcur.execute("UPDATE events SET status='cancelled' WHERE id=%s", (e,))
    dbcur.execute("SELECT status FROM events WHERE id=%s", (e,))
    assert dbcur.fetchone()["status"] == "cancelled"


def _unused_token():  # pragma: no cover
    return secrets.token_urlsafe(24)
