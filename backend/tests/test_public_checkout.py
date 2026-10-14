"""Checkout publico del fan (sin cuenta) sobre el ciclo Wompi de la mig 023.

Lo que protegen estos tests es DINERO y la seguridad de un endpoint SIN sesion:

  * El monto sale de `ticket_types`, NUNCA del cliente: no se puede pagar $0
    mandando un campo en el cuerpo.
  * No se cobra una cortesia, una localidad inactiva, un evento en borrador ni
    uno pasado (misma guardia de venta que el detalle publico).
  * La `reference` es la capability del fan y no se enumera: una inexistente
    es 404.
  * El estado NO expone el token del QR (la boleta se reclama por contacto en
    /boletas, el camino auditado de siempre).
  * Tras aprobar el webhook, el fan ve `approved` y SU boleta existe con el
    contacto que dejo.

La API externa (crear link) se mockea; la emision del webhook SI pasa por la
DB real (approve_ticket_payment -> emit_ticket), igual que en produccion.
"""

import hashlib
import uuid

import pytest

from app.routers import public as public_mod

_LINK = {"id": ""}
_TX = {"n": 0}


def _new_tx_id() -> str:
    _TX["n"] += 1
    return f"tx-fan-{_TX['n']}"


@pytest.fixture()
def wompi_on(monkeypatch):
    """Habilita Wompi y mockea la API externa (crear link)."""
    import app.core.config as config_mod

    settings = config_mod.get_settings()
    monkeypatch.setattr(settings, "wompi_private_key", "prv_test_x", raising=False)
    monkeypatch.setattr(
        settings, "wompi_events_secret", "test_events_y", raising=False
    )

    async def fake_create_payment_link(**kwargs):
        link_id = f"link-fan-{uuid.uuid4().hex[:12]}"
        _LINK["id"] = link_id
        return {"id": link_id, "slug": link_id}

    monkeypatch.setattr(
        public_mod.wompi, "create_payment_link", fake_create_payment_link
    )
    return settings


def _scenario(api, *, price=5000000, courtesy=False, quantity=50):
    """Evento publicado + localidad (paga o cortesia). Devuelve ids."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Fiesta fan {uuid.uuid4().hex[:6]}")
    t = api.add_type(
        "admin", venue, ev["id"], name="General",
        price_cents=price, quantity=quantity, is_courtesy=courtesy,
    )
    api.publish("admin", venue, ev["id"])
    return venue, ev["id"], t


def _checkout(api, event_id, type_id, *, name="Fan Sola", phone="573001112233",
              email="fan@example.test", extra=None):
    payload = {
        "ticket_type_id": type_id,
        "customer_name": name,
        "customer_phone": phone,
        "customer_email": email,
    }
    if extra:
        payload.update(extra)
    return api.client.post(f"/public/events/{event_id}/checkout", json=payload)


def _signed_webhook(secret, *, amount, link_id, status="APPROVED"):
    payload = {
        "event": "transaction.updated",
        "data": {
            "transaction": {
                "id": _new_tx_id(),
                "status": status,
                "amount_in_cents": amount,
                "payment_link_id": link_id,
                "reference": "TF-fan-noimporta",
            }
        },
        "timestamp": 1727000000,
        "signature": {
            "properties": [
                "transaction.id",
                "transaction.status",
                "transaction.amount_in_cents",
            ],
            "checksum": "",
        },
    }
    pieces = []
    for prop in payload["signature"]["properties"]:
        value = payload["data"]
        for part in prop.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        pieces.append("" if value is None else str(value))
    pieces.append(str(payload["timestamp"]))
    pieces.append(secret)
    payload["signature"]["checksum"] = hashlib.sha256(
        "".join(pieces).encode("utf-8")
    ).hexdigest()
    return payload


# ---------------------------------------------------------------------------
# Creacion del cobro
# ---------------------------------------------------------------------------
def test_checkout_creates_pending_payment_with_server_price(api, wompi_on):
    """El cobro nace 'pending' con el precio del SERVIDOR y sin usuario."""
    venue, ev_id, t = _scenario(api, price=5000000)

    res = _checkout(api, ev_id, t["id"])
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["amount_in_cents"] == 5000000
    assert body["reference"].startswith(f"TF-{ev_id}-")
    assert _LINK["id"] in body["payment_url"]
    assert body["status"] == "pending"

    row_status = api.run_sql(
        f"SELECT status FROM ticket_payments WHERE reference = '{body['reference']}'"
    )
    assert row_status == "pending"
    assert (
        api.run_sql(
            f"SELECT created_by_user_id FROM ticket_payments "
            f"WHERE reference = '{body['reference']}'"
        )
        is None
    )


def test_checkout_ignores_client_supplied_amount(api, wompi_on):
    """El monto es del servidor: un campo de monto en el cuerpo se ignora."""
    venue, ev_id, t = _scenario(api, price=5000000)

    res = _checkout(api, ev_id, t["id"], extra={"amount_in_cents": 1})
    assert res.status_code == 201, res.text
    assert res.json()["amount_in_cents"] == 5000000  # no el 1 del cliente


def test_checkout_rejects_courtesy_type(api, wompi_on):
    """Una cortesia no se cobra: 404 (no hay precio que cobrar)."""
    venue, ev_id, t = _scenario(api, price=0, courtesy=True)
    res = _checkout(api, ev_id, t["id"])
    assert res.status_code == 404


def test_checkout_rejects_inactive_type(api, wompi_on):
    """Una localidad desactivada no se vende: 404."""
    venue, ev_id, t = _scenario(api, price=5000000)
    api.run_sql(f"UPDATE ticket_types SET is_active = false WHERE id = {t['id']}")
    res = _checkout(api, ev_id, t["id"])
    assert res.status_code == 404


def test_checkout_rejects_draft_event(api, wompi_on):
    """Un evento sin publicar no vende: 404 uniforme (no filtra existencia)."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Borrador {uuid.uuid4().hex[:6]}")
    t = api.add_type(
        "admin", venue, ev["id"], name="General", price_cents=5000000,
        quantity=50, is_courtesy=False,
    )
    # Sin publicar.
    res = _checkout(api, ev["id"], t["id"])
    assert res.status_code == 404


def test_checkout_503_without_wompi_configured(api):
    """Sin Wompi configurado el checkout no abre (503), como el cobro admin."""
    venue, ev_id, t = _scenario(api, price=5000000)
    res = _checkout(api, ev_id, t["id"])
    assert res.status_code == 503


def test_checkout_accepts_blank_email(api, wompi_on):
    """El correo es opcional: un correo vacio queda nulo, no cadena vacia."""
    venue, ev_id, t = _scenario(api, price=5000000)
    res = _checkout(api, ev_id, t["id"], email="")
    assert res.status_code == 201, res.text
    ref = res.json()["reference"]
    assert (
        api.run_sql(
            f"SELECT customer_email FROM ticket_payments WHERE reference = '{ref}'"
        )
        is None
    )


def test_checkout_requires_phone(api, wompi_on):
    """Sin telefono no hay como entregar la boleta: 422."""
    venue, ev_id, t = _scenario(api, price=5000000)
    res = _checkout(api, ev_id, t["id"], phone="")
    assert res.status_code == 422


# ---------------------------------------------------------------------------
# Estado del cobro (capability)
# ---------------------------------------------------------------------------
def test_status_unknown_reference_is_404(api, wompi_on):
    """La reference es el secreto: una inventada no revela nada (404)."""
    res = api.client.get("/public/checkout/TF-1-deadbeef")
    assert res.status_code == 404


def test_status_pending_then_approved_after_webhook(api, wompi_on):
    """El fan ve 'pending'; tras el webhook ve 'approved' con su boleta."""
    venue, ev_id, t = _scenario(api, price=5000000)
    created = _checkout(api, ev_id, t["id"]).json()
    ref = created["reference"]

    # Aun sin pagar.
    res = api.client.get(f"/public/checkout/{ref}")
    assert res.status_code == 200
    assert res.json()["status"] == "pending"
    assert res.json()["approved"] is False
    assert res.json()["ticket_id"] is None
    # El estado NO expone la credencial del QR.
    assert "raw_token" not in res.json()

    # Wompi aprueba.
    payload = _signed_webhook(
        wompi_on.wompi_events_secret,
        amount=5000000,
        link_id=_LINK["id"],
    )
    hook = api.client.post("/payments/wompi/webhook", json=payload)
    assert hook.status_code == 200, hook.text
    ticket_id = hook.json()["ticket_id"]
    assert ticket_id

    # Ahora el fan ve aprobado, con su boleta, y la boleta es SUYA.
    res2 = api.client.get(f"/public/checkout/{ref}")
    assert res2.json()["status"] == "approved"
    assert res2.json()["approved"] is True
    assert res2.json()["ticket_id"] == ticket_id
    assert (
        api.run_sql(
            f"SELECT customer_phone FROM tickets WHERE id = {ticket_id}"
        )
        == "573001112233"
    )


def test_checkout_reference_has_high_entropy(api, wompi_on):
    """La reference (capability publica) trae 128 bits, no 48."""
    venue, ev_id, t = _scenario(api, price=5000000)
    ref = _checkout(api, ev_id, t["id"]).json()["reference"]
    rand = ref.split("-", 2)[2]  # "TF-<evento>-<hex>"
    assert len(rand) == 32  # 16 bytes hex = 128 bits
