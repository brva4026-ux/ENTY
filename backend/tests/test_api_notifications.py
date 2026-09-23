"""Tests de notificaciones in-app (mig 012, transplante de unicall-blue).

- El trigger de liquidaciones notifica al promotor al CREARSE y al revisarse.
- Disputar notifica a los admins (excluyendo al promotor, obviamente).
- Aceptar una invitación notifica a los admins (el propio aceptante excluido).
- Reemitir una boleta notifica a los admins.
- El feed es privado por usuario y marcar leídas solo toca las propias.

Los triggers viven en la DB: aquí se verifican a través de la API pública
(los endpoints de unicall-blue no aplican: nuestra API es FastAPI + psycopg).
"""

import uuid


# ---------------------------------------------------------------------------
# Helpers de escenario
# ---------------------------------------------------------------------------
def _notifications_for(api, who: str) -> list[dict]:
    res = api.get("/notifications", who)
    assert res.status_code == 200, res.text
    return res.json()


def _unread(api, who: str) -> int:
    res = api.get("/notifications/unread-count", who)
    assert res.status_code == 200
    return res.json()["count"]


def _payout(api, venue: int, promoter_id: int) -> dict:
    """Liquidación pendiente del promotor (cierre de un rango pasado)."""
    res = api.post(
        f"/venues/{venue}/payouts/generate",
        "admin",
        {
            "promoter_id": promoter_id,
            "period_start": "2026-09-01",
            "period_end": "2026-09-10",
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def _dispute(api, venue: int, payout_id: int) -> dict:
    res = api.post(
        f"/venues/{venue}/payouts/{payout_id}/dispute",
        "promoter",
        {"reason": "Emiti mas boletas de las que aparecen en el cierre"},
    )
    assert res.status_code == 200, res.text
    return res.json()


def _review(api, venue: int, payout_id: int, action: str, note: str | None = None) -> dict:
    body: dict = {"action": action}
    if note is not None:
        body["note"] = note
    res = api.post(f"/venues/{venue}/payouts/{payout_id}/review", "admin", body)
    assert res.status_code == 200, res.text
    return res.json()


# ---------------------------------------------------------------------------
# Triggers de liquidaciones
# ---------------------------------------------------------------------------
def test_payout_created_notifies_promoter(api):
    venue = api.world["venue_a"]
    promoter_id = api.world["promoter"]["id"]

    assert _unread(api, "promoter") == 0
    payout = _payout(api, venue, promoter_id)

    feed = _notifications_for(api, "promoter")
    assert len(feed) == 1
    row = feed[0]
    assert row["kind"] == "payout_created"
    assert row["read_at"] is None
    assert row["link"] == "/promotor?tab=liquidaciones"
    assert str(payout["commission_cents"] // 100) in row["body"]

    # El admin no recibe nada por crear la liquidación: la novedad es del promotor.
    assert _notifications_for(api, "admin") == []


def test_payout_disputed_notifies_admins_not_promoter(api):
    venue = api.world["venue_a"]
    promoter_id = api.world["promoter"]["id"]
    payout = _payout(api, venue, promoter_id)
    _notifications_for(api, "promoter")  # el promotor ya vio la creación

    _dispute(api, venue, payout["id"])

    admin_feed = _notifications_for(api, "admin")
    assert len(admin_feed) == 1
    row = admin_feed[0]
    assert row["kind"] == "payout_disputed"
    assert "no esta de acuerdo" in row["body"] or "no está de acuerdo" in row["body"]
    assert row["link"] == "/admin?tab=liquidaciones"

    # Al promotor no llega duplicado (solo la de creación de antes).
    assert len(_notifications_for(api, "promoter")) == 1


def test_payout_reviewed_notifies_promoter(api):
    venue = api.world["venue_a"]
    payout = _payout(api, venue, api.world["promoter"]["id"])

    _review(api, venue, payout["id"], "pay", note="Pago por Nequi")

    feed = _notifications_for(api, "promoter")
    kinds = [n["kind"] for n in feed]
    assert kinds == ["payout_reviewed", "payout_created"]  # más nuevo primero
    assert "Nequi" not in feed[0]["body"]  # la nota del admin no se filtra al texto


def test_rejected_payout_includes_review_note(api):
    venue = api.world["venue_a"]
    payout = _payout(api, venue, api.world["promoter"]["id"])

    _review(api, venue, payout["id"], "reject", note="Faltan soportes de las cortesias")

    feed = _notifications_for(api, "promoter")
    top = feed[0]
    assert top["kind"] == "payout_reviewed"
    assert "Faltan soportes" in top["body"]


# ---------------------------------------------------------------------------
# Trigger de invitaciones aceptadas
# ---------------------------------------------------------------------------
def test_invitation_accepted_notifies_admins(api):
    venue = api.world["venue_a"]
    # El admin crea la invitación; un invitado real la acepta desde la página pública.
    res = api.post(
        f"/auth/venues/{venue}/invitations",
        "admin",
        {
            "full_name": "Portero Notificado",
            "email": f"notif-{uuid.uuid4().hex[:8]}@example.test",
            "role": "bouncer",
            "expires_hours": 24,
        },
    )
    assert res.status_code == 201, res.text
    token = res.json()["invite_url"].split("token=")[1]

    res = api.client.post(
        "/auth/invitations/accept",
        json={"token": token, "password": "Clave-Segura-123"},
    )
    assert res.status_code == 200, res.text
    accepted = res.json()

    feed = _notifications_for(api, "admin")
    assert len(feed) == 1
    row = feed[0]
    assert row["kind"] == "invitation_accepted"
    assert row["link"] == "/admin?tab=equipo"
    # El aceptante queda excluido: no se auto-notifica.
    accepted_user_id = accepted.get("user", {}).get("id") or accepted.get("user_id")
    if accepted_user_id:
        who = None
        for candidate in ("admin", "promoter", "bouncer", "outsider"):
            if api.world[candidate]["id"] == accepted_user_id:
                who = candidate
                break
        if who:
            assert all(n["kind"] != "invitation_accepted" for n in _notifications_for(api, who))


# ---------------------------------------------------------------------------
# Trigger de reemisión de boletas
# ---------------------------------------------------------------------------
def test_reissue_notifies_admins(api):
    s = api.scenario()
    venue, event = s["venue"], s["event"]
    ticket = api.emit(
        "promoter", venue, event,
        ticket_type_id=s["type"], allocation_id=s["allocation"]["id"],
    )
    _notifications_for(api, "admin")  # limpia el baseline

    res = api.post(
        f"/venues/{venue}/events/{event}/tickets/{ticket['ticket_id']}/reissue",
        "promoter",
        {"reason": "El invitado perdio el WhatsApp"},
    )
    assert res.status_code == 200, res.text

    feed = _notifications_for(api, "admin")
    assert len(feed) == 1
    row = feed[0]
    assert row["kind"] == "ticket_reissued"
    assert "perdio el WhatsApp" in row["body"] or "perdió el WhatsApp" in row["body"]


# ---------------------------------------------------------------------------
# Privacidad y marcado de lectura
# ---------------------------------------------------------------------------
def test_feed_is_private_per_user(api):
    venue = api.world["venue_a"]
    _payout(api, venue, api.world["promoter"]["id"])

    # El promotor ve su notificación; el promotor2 (misma venue) no ve nada.
    assert len(_notifications_for(api, "promoter")) == 1
    assert _notifications_for(api, "promoter2") == []


def test_mark_read_specific_ids_only(api):
    venue = api.world["venue_a"]
    p1 = _payout(api, venue, api.world["promoter"]["id"])
    # Segunda liquidación: el rango secuencial debe empezar después del cierre anterior.
    res = api.post(
        f"/venues/{venue}/payouts/generate",
        "admin",
        {
            "promoter_id": api.world["promoter"]["id"],
            "period_start": "2026-09-11",
            "period_end": "2026-09-20",
        },
    )
    assert res.status_code == 201, res.text

    feed = _notifications_for(api, "promoter")
    assert len(feed) == 2
    newest, oldest = feed[0], feed[1]

    # Marca solo la más nueva.
    res = api.post("/notifications/read", "promoter", {"ids": [newest["id"]]})
    assert res.status_code == 204

    feed = _notifications_for(api, "promoter")
    by_id = {n["id"]: n for n in feed}
    assert by_id[newest["id"]]["read_at"] is not None
    assert by_id[oldest["id"]]["read_at"] is None
    assert _unread(api, "promoter") == 1

    # Marca todo lo restante.
    res = api.post("/notifications/read", "promoter", {"ids": []})
    assert res.status_code == 204
    assert _unread(api, "promoter") == 0


def test_mark_read_cannot_touch_other_users(api):
    venue = api.world["venue_a"]
    _payout(api, venue, api.world["promoter"]["id"])
    feed = _notifications_for(api, "promoter")
    other_id = feed[0]["id"]

    # Promotor2 intenta marcar la notificación ajena: no matchea, no explota.
    res = api.post("/notifications/read", "promoter2", {"ids": [other_id]})
    assert res.status_code == 204
    assert _unread(api, "promoter") == 1


def test_feed_pagination_keyset(api):
    venue = api.world["venue_a"]
    promoter_id = api.world["promoter"]["id"]
    _payout(api, venue, promoter_id)
    res = api.post(
        f"/venues/{venue}/payouts/generate",
        "admin",
        {
            "promoter_id": promoter_id,
            "period_start": "2026-09-11",
            "period_end": "2026-09-20",
        },
    )
    assert res.status_code == 201, res.text

    first_page = _notifications_for(api, "promoter")
    assert len(first_page) == 2

    # Pagina desde la última fila de la primera página.
    res = api.get(f"/notifications?before={first_page[-1]['id']}&limit=10", "promoter")
    assert res.status_code == 200
    assert res.json() == []  # no hay filas más viejas
