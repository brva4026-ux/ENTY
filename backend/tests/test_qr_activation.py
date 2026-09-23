"""Tests de activación del QR (mig 013, patrón DICE).

- El preview público devuelve qr_active=False fuera de la ventana, con la
  fecha de activación; True dentro.
- El JPEG público (POST /tickets/image y GET /public/.../image.jpg) NO se
  compone fuera de la ventana.
- redeem_ticket rechaza con NOT_ACTIVE (sin consumir) y el intento queda
  auditado como 'not_active'.
- El staff puede forzar el ingreso (force=true) con outcome granted_forced.
- Dentro de la ventana todo funciona igual que antes.
"""

from datetime import datetime, timedelta, timezone


def _closed_window_event(api, venue: int, *, hours: int = 72) -> dict:
    """Evento publicado con la ventana de activación CERRADA (empieza en N horas)."""
    ev = api.create_event(
        "admin",
        venue,
        starts_at=(datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat(),
    )
    t = api.add_type("admin", venue, ev["id"], quantity=20)
    api.publish("admin", venue, ev["id"])
    return ev


def _open_window_event(api, venue: int) -> dict:
    """Evento publicado cuya ventana de activación ya está ABIERTA.

    Default unlock=60 min: arrancando en +30 min, la ventana abre en
    ahora+30-60 = hace 30 min. Con +29h (el default del fixture) la ventana
    todavía NO abría y estos tests probaban lo contrario de su nombre.
    """
    ev = api.create_event(
        "admin",
        venue,
        starts_at=(datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
    )
    t = api.add_type("admin", venue, ev["id"], quantity=20)
    api.publish("admin", venue, ev["id"])
    return ev


def _emit(api, ev: dict) -> dict:
    t = api.types("admin", api.world["venue_a"], ev["id"])[0]
    alloc = api.set_allocation(
        "admin",
        api.world["venue_a"],
        ev["id"],
        ticket_type_id=t["id"],
        promoter_id=api.world["promoter"]["id"],
        capacity=20,
    )
    return api.emit(
        "promoter",
        api.world["venue_a"],
        ev["id"],
        ticket_type_id=t["id"],
        allocation_id=alloc["id"],
    )


# ===========================================================================
# Preview público
# ===========================================================================
def test_preview_reports_locked_qr_outside_window(api):
    venue = api.world["venue_a"]
    ev = _closed_window_event(api, venue)
    ticket = _emit(api, ev)

    res = api.client.post(
        "/tickets/preview", json={"raw_token": ticket["raw_token"]}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["qr_active"] is False
    assert body["qr_message"] and "activa" in body["qr_message"]


def test_preview_reports_active_qr_inside_window(api):
    venue = api.world["venue_a"]
    ev = _open_window_event(api, venue)
    ticket = _emit(api, ev)

    res = api.client.post(
        "/tickets/preview", json={"raw_token": ticket["raw_token"]}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["qr_active"] is True
    assert body["qr_message"] is None


# ===========================================================================
# Imagen pública (los dos canales)
# ===========================================================================
def test_post_image_forbidden_outside_window(api):
    venue = api.world["venue_a"]
    ev = _closed_window_event(api, venue)
    ticket = _emit(api, ev)

    res = api.client.post("/tickets/image", json={"raw_token": ticket["raw_token"]})
    assert res.status_code == 403
    assert "activa" in res.json()["detail"]


def test_get_image_forbidden_outside_window(api):
    venue = api.world["venue_a"]
    ev = _closed_window_event(api, venue)
    ticket = _emit(api, ev)

    res = api.client.get(f"/public/tickets/{ticket['raw_token']}/image.jpg")
    assert res.status_code == 403


def test_get_image_ok_inside_window(api):
    venue = api.world["venue_a"]
    ev = _open_window_event(api, venue)
    ticket = _emit(api, ev)

    res = api.client.get(f"/public/tickets/{ticket['raw_token']}/image.jpg")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/jpeg"


# ===========================================================================
# La puerta: redeem_ticket
# ===========================================================================
def _scan(api, ev: dict, raw_token: str, **extra) -> dict:
    res = api.post(
        f"/venues/{api.world['venue_a']}/events/{ev['id']}/redeem",
        "bouncer",
        {"raw_token": raw_token, **extra},
    )
    assert res.status_code == 200, res.text
    return res.json()


def test_scan_rejected_not_active_outside_window(api, dbcur):
    venue = api.world["venue_a"]
    ev = _closed_window_event(api, venue)
    ticket = _emit(api, ev)
    api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")

    out = _scan(api, ev, ticket["raw_token"])
    assert out["code"] == "NOT_ACTIVE"
    assert out["redeemed"] is False
    # Accionable en la puerta: la hora exacta de activación, no un "vuelve luego".
    assert out["detail"] and "QR se activa" in out["detail"]

    # No se consumió y el intento quedó auditado.
    dbcur.execute("SELECT status FROM tickets WHERE id=%s", (ticket["ticket_id"],))
    assert dbcur.fetchone()["status"] == "issued"
    dbcur.execute(
        "SELECT outcome FROM redemptions WHERE ticket_id=%s ORDER BY id DESC LIMIT 1",
        (ticket["ticket_id"],),
    )
    assert dbcur.fetchone()["outcome"] == "not_active"


def test_scan_granted_inside_window(api):
    venue = api.world["venue_a"]
    ev = _open_window_event(api, venue)
    ticket = _emit(api, ev)

    out = _scan(api, ev, ticket["raw_token"])
    assert out["code"] == "GRANTED"
    assert out["redeemed"] is True


def test_staff_can_force_entry_outside_window(api, dbcur):
    venue = api.world["venue_a"]
    ev = _closed_window_event(api, venue)
    ticket = _emit(api, ev)
    api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")

    # El bouncer NO puede forzar: force es decision de staff (403), el
    # escaner automatico nunca deja pasar fuera de ventana.
    res_bouncer = api.post(
        f"/venues/{venue}/events/{ev['id']}/redeem",
        "bouncer",
        {"raw_token": ticket["raw_token"], "force": True},
    )
    assert res_bouncer.status_code == 403

    # El admin sí: canje real, auditado como granted_forced.
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/redeem",
        "admin",
        {"raw_token": ticket["raw_token"], "force": True},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["code"] == "GRANTED"
    assert body["redeemed"] is True

    dbcur.execute("SELECT status FROM tickets WHERE id=%s", (ticket["ticket_id"],))
    assert dbcur.fetchone()["status"] == "redeemed"
    dbcur.execute(
        "SELECT outcome FROM redemptions WHERE ticket_id=%s ORDER BY id DESC LIMIT 1",
        (ticket["ticket_id"],),
    )
    assert dbcur.fetchone()["outcome"] == "granted_forced"
