"""Un cupón con max_uses NUNCA se aplica más veces que su tope.

La invariante la sostiene el modelo de RESERVAS de checkout (mig 044): al crear
el pago se aparta el cupo del cupón, y `approve_ticket_payment` revalida
`used_count + reservas < max_uses` con `FOR UPDATE` antes de incrementar. El
segundo fan que llega con el cupón ya agotado (o reservado) NO obtiene el
descuento: compra al precio de lista, que es el contrato documentado del
checkout para un código que no aplica.
"""
import hashlib
import uuid

import pytest

from app.routers import public as public_mod

_LINK = {"id": ""}
_TX = {"n": 0}


def _new_tx() -> str:
    _TX["n"] += 1
    return f"tx-coupon-{uuid.uuid4().hex[:10]}-{_TX['n']}"


@pytest.fixture()
def wompi_on(monkeypatch):
    import app.core.config as config_mod

    settings = config_mod.get_settings()
    monkeypatch.setattr(settings, "wompi_private_key", "prv_test_x", raising=False)
    monkeypatch.setattr(settings, "wompi_events_secret", "test_events_y", raising=False)

    async def fake_link(**kwargs):
        link_id = f"link-coupon-{uuid.uuid4().hex[:12]}"
        _LINK["id"] = link_id
        return {"id": link_id, "slug": link_id}

    monkeypatch.setattr(public_mod.wompi, "create_payment_link", fake_link)
    return settings


def _signed(payload: dict, secret: str) -> dict:
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


def _approve(api, link_id: str, amount: int):
    payload = {
        "event": "transaction.updated",
        "data": {
            "transaction": {
                "id": _new_tx(),
                "status": "APPROVED",
                "amount_in_cents": amount,
                "payment_link_id": link_id,
                "reference": "x",
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
    _signed(payload, "test_events_y")
    return api.client.post("/payments/wompi/webhook", json=payload)


def test_coupon_max_uses_cannot_be_exceeded(api, wompi_on):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Cupón tope")
    t = api.add_type(
        "admin", venue, ev["id"], name="General",
        price_cents=1000000, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    base = f"/venues/{venue}/events/{ev['id']}/coupons"
    coupon = api.post(
        base, "admin",
        {"code": "UNICO", "kind": "fixed", "value": 100000, "max_uses": 1},
    ).json()
    assert coupon["max_uses"] == 1

    # Dos compras con el mismo cupón: ambas se crean ANTES de aprobar ninguna,
    # que es exactamente el caso real (dos fans comprando a la vez). El cupo del
    # cupón (1 uso) lo aparta la PRIMERA; la segunda no recibe descuento y paga
    # el precio de lista.
    for _ in range(2):
        res = api.client.post(
            f"/public/events/{ev['id']}/checkout",
            json={
                "ticket_type_id": t["id"],
                "customer_name": "Fan",
                "customer_phone": "573001112233",
                "coupon_code": "UNICO",
            },
        )
        assert res.status_code == 201, res.text

    # Aprobar ambos por webhook (con el link real de cada cobro).
    links = api.run_sql(
        "SELECT string_agg(provider_ref || ':' || amount_in_cents, ',') "
        "FROM ticket_payments WHERE event_id = %d" % ev["id"]
    ).split(",")
    for pair in links:
        link_id, amount = pair.split(":")
        assert _approve(api, link_id, int(amount)).status_code == 200

    # La invariante: el cupón se aplicó UNA sola vez (max_uses=1). El otro fan
    # compró al precio de lista (sin descuento, sin cupón asociado).
    used = api.run_sql("SELECT used_count FROM coupons WHERE id = %d" % coupon["id"])
    assert used == 1, f"cupón usado {used} veces con max_uses=1"
    discounted = api.run_sql(
        "SELECT count(*) FROM ticket_payments WHERE event_id = %d AND coupon_id = %d"
        % (ev["id"], coupon["id"])
    )
    assert discounted == 1, f"{discounted} cobros con el cupón de 1 uso"
    amounts = sorted(
        int(a) for a in api.run_sql(
            "SELECT string_agg(amount_in_cents::text, ',') FROM ticket_payments "
            "WHERE event_id = %d" % ev["id"]
        ).split(",")
    )
    # Uno con descuento (1000000 - 100000) y otro a precio de lista.
    assert amounts == [900000, 1000000], amounts
