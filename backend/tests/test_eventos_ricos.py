"""Eventos más ricos (mig 043): categoría, lineup, cupones, reembolso.

La segunda mitad de la tanda "operar la noche". Lo que protegen estos tests:

  * La CATEGORÍA es elegida por el organizador y manda sobre la heurística del
    catálogo; una categoría fuera de la lista se rechaza.
  * El LINEUP es CRUD real (antes la ficha devolvía [] siempre) y sale en el
    detalle público ordenado por cartel.
  * Los CUPONES descuentan de verdad en el checkout: el monto que va a Wompi es
    el NETO, el uso se cuenta y la boleta queda con el precio pagado.
  * El REEMBOLSO es el camino que asigna `refunded` (estado huérfano hasta
    ahora): libera cupo, deja la salida en caja y es idempotente.
  * El RECORDATORIO avisa una sola vez por evento (marca reminded_at).
"""
import hashlib
import uuid

import pytest

from app.routers import public as public_mod

_LINK = {"id": ""}


@pytest.fixture()
def wompi_on(monkeypatch):
    import app.core.config as config_mod

    settings = config_mod.get_settings()
    monkeypatch.setattr(settings, "wompi_private_key", "prv_test_x", raising=False)
    monkeypatch.setattr(settings, "wompi_events_secret", "test_events_y", raising=False)

    async def fake_create_payment_link(**kwargs):
        link_id = f"link-ricos-{uuid.uuid4().hex[:12]}"
        _LINK["id"] = link_id
        return {"id": link_id, "slug": link_id}

    monkeypatch.setattr(public_mod.wompi, "create_payment_link", fake_create_payment_link)
    return settings


def _tag() -> str:
    return uuid.uuid4().hex[:8]


# ---------------------------------------------------------------------------
# Categoría
# ---------------------------------------------------------------------------
def test_category_is_chosen_and_wins_over_heuristic(api):
    venue = api.world["venue_a"]
    # El nombre sugiere "Deportes" (heurística), pero el organizador eligió
    # "Fiesta": la elección manda.
    ev = api.create_event(
        "admin", venue, name=f"Final de Liga {_tag()}", category="Fiesta"
    )
    assert ev["category"] == "Fiesta"

    res = api.patch(
        f"/venues/{venue}/events/{ev['id']}", "admin", {"category": "Comedia"}
    )
    assert res.status_code == 200, res.text
    assert res.json()["category"] == "Comedia"


def test_invalid_category_is_rejected(api):
    venue = api.world["venue_a"]
    res = api.post(
        f"/venues/{venue}/events",
        "admin",
        {
            "name": f"Rara {_tag()}",
            "starts_at": "2030-01-01T20:00:00-05:00",
            "capacity": 10,
            "category": "Karaoke",
        },
    )
    assert res.status_code == 422, res.text


def test_public_catalog_uses_chosen_category(api, api_client):
    venue = api.world["venue_a"]
    tag = _tag()
    city = f"CiudadCatElegida{tag}"
    name = f"Concierto Neon {tag}"
    ev = api.create_event(
        "admin", venue, name=name, capacity=50, location=city, category="Cultural"
    )
    api.publish("admin", venue, ev["id"])

    body = api_client.get("/public/events", params={"city": city}).json()
    show = next(e for e in body["events"] if e["name"] == name)
    assert show["category"] == "Cultural"


# ---------------------------------------------------------------------------
# Lineup
# ---------------------------------------------------------------------------
def test_lineup_crud_and_public_detail(api, api_client):
    venue = api.world["venue_a"]
    tag = _tag()
    city = f"CiudadLineup{tag}"
    ev = api.create_event("admin", venue, name=f"Lineup {tag}", capacity=50, location=city)
    base = f"/venues/{venue}/events/{ev['id']}/lineup"

    r1 = api.post(base, "admin", {"name": "DJ Principal", "role": "headliner", "sort_order": 1})
    assert r1.status_code == 201, r1.text
    r2 = api.post(base, "admin", {"name": "Telonero", "role": "opening", "sort_order": 0})
    assert r2.status_code == 201, r2.text

    listed = api.get(base, "admin")
    assert listed.status_code == 200
    assert [i["name"] for i in listed.json()] == ["Telonero", "DJ Principal"]

    upd = api.patch(f"{base}/{r1.json()['id']}", "admin", {"name": "DJ Estelar", "sort_order": 2})
    assert upd.status_code == 200, upd.text
    assert upd.json()["name"] == "DJ Estelar"

    api.publish("admin", venue, ev["id"])
    detail = api_client.get(f"/public/events/{ev['id']}").json()
    assert [i["name"] for i in detail["lineup"]] == ["Telonero", "DJ Estelar"]

    dele = api.delete(f"{base}/{r2.json()['id']}", "admin")
    assert dele.status_code == 200, dele.text
    assert [i["name"] for i in api.get(base, "admin").json()] == ["DJ Estelar"]


def test_lineup_requires_admin_role(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Lineup rol {_tag()}")
    base = f"/venues/{venue}/events/{ev['id']}/lineup"
    res = api.post(base, "promoter", {"name": "X"})
    assert res.status_code == 403, res.text


# ---------------------------------------------------------------------------
# Cupones: CRUD
# ---------------------------------------------------------------------------
def test_coupon_crud_and_delete_semantics(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Cupones {_tag()}")
    base = f"/venues/{venue}/events/{ev['id']}/coupons"

    res = api.post(
        base, "admin",
        {"code": "temprano20", "kind": "percent", "value": 20, "max_uses": 5},
    )
    assert res.status_code == 201, res.text
    coupon = res.json()
    assert coupon["code"] == "TEMPRANO20"  # normalizado
    assert coupon["used_count"] == 0

    # Código duplicado (case-insensitive) -> 409.
    dup = api.post(base, "admin", {"code": "TEMPRANO20", "kind": "percent", "value": 10})
    assert dup.status_code == 409, dup.text

    upd = api.patch(f"{base}/{coupon['id']}", "admin", {"is_active": False})
    assert upd.status_code == 200, upd.text
    assert upd.json()["is_active"] is False

    # Sin usos: se borra de verdad.
    dele = api.delete(f"{base}/{coupon['id']}", "admin")
    assert dele.status_code == 200, dele.text
    assert api.get(base, "admin").json() == []


def test_percent_coupon_out_of_range_is_rejected(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Cupón rango {_tag()}")
    base = f"/venues/{venue}/events/{ev['id']}/coupons"
    res = api.post(base, "admin", {"code": "GRATIS", "kind": "percent", "value": 100})
    assert res.status_code == 422, res.text


# ---------------------------------------------------------------------------
# Cupones: checkout público
# ---------------------------------------------------------------------------
def _priced_event(api, *, price=1000000, quantity=50):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Fan cupón {_tag()}")
    t = api.add_type(
        "admin", venue, ev["id"], name="General",
        price_cents=price, quantity=quantity, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    return venue, ev["id"], t


def _checkout(api, event_id, type_id, *, extra=None):
    payload = {
        "ticket_type_id": type_id,
        "customer_name": "Fan Cupón",
        "customer_phone": "573001112233",
        "customer_email": "fan@example.test",
    }
    if extra:
        payload.update(extra)
    return api.client.post(f"/public/events/{event_id}/checkout", json=payload)


def test_coupon_quote_does_not_consume(api):
    venue, ev_id, t = _priced_event(api, price=1000000)
    base = f"/venues/{venue}/events/{ev_id}/coupons"
    api.post(base, "admin", {"code": "MITAD", "kind": "percent", "value": 50})

    res = api.client.get(
        f"/public/events/{ev_id}/coupon",
        params={"ticket_type_id": t["id"], "code": "mitad"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["discount_in_cents"] == 500000
    assert body["final_in_cents"] == 500000
    assert body["valid"] is True

    # Cotizar no consume: used_count sigue en 0.
    assert api.run_sql(
        f"SELECT used_count FROM coupons WHERE event_id = {ev_id}"
    ) == 0


def test_checkout_charges_net_amount_with_coupon(api, wompi_on):
    venue, ev_id, t = _priced_event(api, price=1000000)
    base = f"/venues/{venue}/events/{ev_id}/coupons"
    api.post(base, "admin", {"code": "TEMPRANO20", "kind": "percent", "value": 20})

    res = _checkout(api, ev_id, t["id"], extra={"coupon_code": "temprano20"})
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["amount_in_cents"] == 800000  # 20% menos

    discount = api.run_sql(
        f"SELECT discount_in_cents FROM ticket_payments WHERE reference = '{body['reference']}'"
    )
    assert discount == 200000


def test_checkout_ignores_invalid_coupon(api, wompi_on):
    venue, ev_id, t = _priced_event(api, price=1000000)
    # No existe el cupón: se cobra el precio de lista, no se rechaza la compra.
    res = _checkout(api, ev_id, t["id"], extra={"coupon_code": "NOEXISTE"})
    assert res.status_code == 201, res.text
    assert res.json()["amount_in_cents"] == 1000000


def test_full_cover_coupon_is_rejected(api, wompi_on):
    venue, ev_id, t = _priced_event(api, price=1000000)
    base = f"/venues/{venue}/events/{ev_id}/coupons"
    # Descuento fijo mayor que el precio: dejaría el cobro en 0. Wompi no cobra
    # $0 y una boleta gratis es cortesía, no descuento: se rechaza con 409.
    api.post(base, "admin", {"code": "GRANDE", "kind": "fixed", "value": 5000000})
    res = _checkout(api, ev_id, t["id"], extra={"coupon_code": "GRANDE"})
    assert res.status_code == 409, res.text


# ---------------------------------------------------------------------------
# Reembolso
# ---------------------------------------------------------------------------
def test_refund_frees_quota_and_is_idempotent(api):
    scen = api.scenario(alloc_capacity=1)
    ticket = api.emit(
        "promoter", scen["venue"], scen["event"],
        ticket_type_id=scen["type"], allocation_id=scen["allocation"]["id"],
    )
    url = (
        f"/venues/{scen['venue']}/events/{scen['event']}"
        f"/tickets/{ticket['ticket_id']}/refund"
    )
    res = api.post(url, "admin", {"reason": "el fan no puede ir"})
    assert res.status_code == 200, res.text

    assert api.run_sql(
        f"SELECT status FROM tickets WHERE id = {ticket['ticket_id']}"
    ) == "refunded"
    [alloc] = api.allocations("admin", scen["venue"], scen["event"])
    assert alloc["issued"] == 0

    # Idempotente: reembolsar dos veces no duplica la salida de caja.
    again = api.post(url, "admin", {"reason": "de nuevo"})
    assert again.status_code == 200, again.text
    refunds = api.run_sql(
        f"SELECT count(*) FROM ticket_refunds WHERE ticket_id = {ticket['ticket_id']}"
    )
    assert refunds == 1


def test_refund_rejected_for_redeemed_ticket(api):
    scen = api.scenario()
    ticket = api.emit(
        "promoter", scen["venue"], scen["event"],
        ticket_type_id=scen["type"], allocation_id=scen["allocation"]["id"],
    )
    # La boleta entra al evento (canje) y luego se intenta reembolsar.
    api.run_sql(
        f"UPDATE tickets SET status = 'redeemed' WHERE id = {ticket['ticket_id']}"
    )
    url = (
        f"/venues/{scen['venue']}/events/{scen['event']}"
        f"/tickets/{ticket['ticket_id']}/refund"
    )
    res = api.post(url, "admin", {"reason": "ya entró"})
    assert res.status_code == 409, res.text


def test_refund_requires_admin_role(api):
    scen = api.scenario()
    ticket = api.emit(
        "promoter", scen["venue"], scen["event"],
        ticket_type_id=scen["type"], allocation_id=scen["allocation"]["id"],
    )
    url = (
        f"/venues/{scen['venue']}/events/{scen['event']}"
        f"/tickets/{ticket['ticket_id']}/refund"
    )
    res = api.post(url, "promoter", {"reason": "no soy admin"})
    assert res.status_code == 403, res.text


def test_refund_amount_cannot_exceed_price_paid(api):
    """El monto reembolsado no puede superar lo que costó la boleta.

    El esquema registraba el monto tal cual (COALESCE(amount,
    price_cents_snapshot)) y el endpoint lo aceptaba del cliente sin tope: un
    admin podía dejar en caja una salida mayor que el recaudo real.
    """
    scen = api.scenario()  # el tipo del scenario es cortesía (precio 0)
    ticket = api.emit(
        "promoter", scen["venue"], scen["event"],
        ticket_type_id=scen["type"], allocation_id=scen["allocation"]["id"],
    )
    url = (
        f"/venues/{scen['venue']}/events/{scen['event']}"
        f"/tickets/{ticket['ticket_id']}/refund"
    )
    res = api.post(
        url, "admin",
        {"reason": "devolución inflada", "amount_in_cents": 99999999},
    )
    assert res.status_code == 409, res.text
    assert api.run_sql(
        f"SELECT count(*) FROM ticket_refunds WHERE ticket_id = {ticket['ticket_id']}"
    ) == 0
    assert api.run_sql(
        f"SELECT status FROM tickets WHERE id = {ticket['ticket_id']}"
    ) == "issued"


# ---------------------------------------------------------------------------
# Recordatorio de la noche
# ---------------------------------------------------------------------------
def test_reminder_fires_once_per_event(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Recordatorio {_tag()}")
    api.publish("admin", venue, ev["id"])
    # El evento nace a +29h; se mueve a +1h para entrar en la ventana de 2h.
    api.run_sql(
        f"UPDATE events SET starts_at = now() + INTERVAL '1 hour' WHERE id = {ev['id']}"
    )

    first = api.run_sql("SELECT notify_event_reminders()")
    assert first >= 1
    assert api.run_sql(
        f"SELECT reminded_at IS NOT NULL FROM events WHERE id = {ev['id']}"
    ) is True

    # Segunda corrida: ya está marcado, no vuelve a contar.
    assert api.run_sql("SELECT notify_event_reminders()") == 0
