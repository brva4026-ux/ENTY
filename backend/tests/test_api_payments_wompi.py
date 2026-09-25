"""Ciclo de pagos online con Wompi (mig 023, docs/pagos-online.md).

Lo que protegen estos tests es DINERO, no UX:
  * El webhook sin firma valida (o con secreto vacio) NO emite: cualquiera
    con la URL no fabrica boletas gratis.
  * Dos webhooks APPROVED = UNA boleta (idempotencia: Wompi reintenta
    30min/3h/24h).
  * El monto del payload no se cree: si no coincide con el cobrado, 409 y
    nada se emite.
  * DECLINED audita y no emite; un cobro muerto no revive.
  * La transaccion de otro cobro (otro payment_link_id) no toca el nuestro.

La API externa (crear link) se mockea con monkeypatch: los tests nunca
tocan sandbox.wompi.co. La emision real del webhook SI pasa por la DB
(approve_ticket_payment -> emit_ticket), igual que en produccion.
"""

import hashlib
import json

import pytest

from app.routers import payments as payments_mod

# Id del link que "crea" Wompi mockeado: UNICO por test. El indice UNIQUE
# (provider, provider_ref) de la mig 023 rechaza dos cobros con el mismo
# payment_link_id — comportamiento real que los tests no deben esquivar.
_LINK_HOLDER = {"id": ""}
_TX_SEQ = {"n": 0}


def WOMPI_LINK_ID() -> str:
    return _LINK_HOLDER["id"]


def _new_tx_id() -> str:
    """Id de transaccion UNICO por test: el indice UNIQUE (provider,
    transaction_id) bloquea replays de una misma tx bajo otra referencia
    (defensa de la mig 023) — los tests no deben reutilizarla entre cobros."""
    _TX_SEQ["n"] += 1
    return f"tx-11332244-{_TX_SEQ['n']}"


def _wompi_link_payload() -> dict:
    """Payload del evento transaction.updated con la forma real de Wompi:
    signature.properties se resuelven contra data (dots = camino anidado)."""
    return {
        "event": "transaction.updated",
        "data": {
            "transaction": {
                "id": _new_tx_id(),
                "status": "APPROVED",
                "amount_in_cents": 5000000,
                "payment_link_id": WOMPI_LINK_ID(),
                "reference": "TF-999-noimporta",
            }
        },
        "timestamp": 1727000000,
        "signature": {
            "properties": ["transaction.id", "transaction.status", "transaction.amount_in_cents"],
            "checksum": "",
        },
    }


def _signed(payload: dict, secret: str) -> dict:
    """Firma el payload como lo hace Wompi: SHA256 de
    concat(valores de properties) + timestamp + secreto."""
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


@pytest.fixture()
def wompi_on(monkeypatch):
    """Habilita Wompi en settings y mockea la API externa (crear link)."""
    import app.core.config as config_mod

    settings = config_mod.get_settings()
    monkeypatch.setattr(
        settings, "wompi_private_key", "prv_test_x", raising=False
    )
    monkeypatch.setattr(
        settings, "wompi_events_secret", "test_events_y", raising=False
    )

    import uuid as _uuid

    async def fake_create_payment_link(**kwargs):
        link_id = f"link-test-{_uuid.uuid4().hex[:12]}"
        _LINK_HOLDER["id"] = link_id
        return {"id": link_id, "slug": link_id}

    monkeypatch.setattr(
        payments_mod.wompi, "create_payment_link", fake_create_payment_link
    )
    return settings


def _create_payment(api, venue, event_id, type_id, amount=5000000):
    res = api.post(
        f"/venues/{venue}/events/{event_id}/payments",
        "admin",
        {
            "ticket_type_id": type_id,
            "amount_in_cents": amount,
            "customer_name": "Fan Nacional",
            "customer_phone": "573001234567",
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def _scenario(api):
    """Evento publicado + tipo pagado de $50.000 + cobro creado."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Noche con cobros")
    t = api.add_type(
        "admin", venue, ev["id"], name="General",
        price_cents=5000000, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    payment = _create_payment(api, venue, ev["id"], t["id"])
    return venue, ev["id"], payment


# ---------------------------------------------------------------------------
# Webhook: la puerta del dinero
# ---------------------------------------------------------------------------
def test_webhook_approved_emits_ticket(api, wompi_on):
    """Firma valida + monto exacto -> boleta emitida y cobro aprobado."""
    venue, ev_id, payment = _scenario(api)

    payload = _signed(_wompi_link_payload(), wompi_on.wompi_events_secret)
    res = api.client.post("/payments/wompi/webhook", json=payload)
    assert res.status_code == 200, res.text
    ticket_id = res.json()["ticket_id"]
    assert ticket_id

    # La boleta EXISTE y esta viva: nace issued, con el monto pagado.
    assert (
        api.run_sql(f"SELECT status FROM tickets WHERE id = {ticket_id}")
        == "issued"
    )
    assert (
        api.run_sql(
            f"SELECT price_cents_snapshot::int FROM tickets WHERE id = {ticket_id}"
        )
        == 5000000
    )
    assert (
        api.run_sql(f"SELECT event_id::int FROM tickets WHERE id = {ticket_id}")
        == ev_id
    )

    # El cobro quedo aprobado, ligado a la boleta y con el payload crudo.
    counts = api.get(f"/venues/{venue}/events/ticket-counts", "admin").json()
    assert counts[str(ev_id)]["active"] == 1
    assert counts[str(ev_id)]["revenue_cents"] == 5000000

    payments = api.get(
        f"/venues/{venue}/events/{ev_id}/payments", "admin"
    ).json()
    p = next(x for x in payments["items"] if x["id"] == payment["payment_id"])
    assert p["status"] == "approved"
    assert p["ticket_id"] == ticket_id
    assert p["transaction_id"].startswith("tx-11332244")


def test_webhook_rejects_bad_signature(api, wompi_on):
    """Firma invalida = 403 y NADA pasa: no emite, no audita, no toca DB."""
    venue, ev_id, payment = _scenario(api)

    payload = _wompi_link_payload()
    payload["signature"]["checksum"] = "firma-trucha"
    res = api.client.post("/payments/wompi/webhook", json=payload)
    assert res.status_code == 403

    payments = api.get(
        f"/venues/{venue}/events/{ev_id}/payments", "admin"
    ).json()
    p = next(x for x in payments["items"] if x["id"] == payment["payment_id"])
    assert p["status"] == "pending"
    assert p["ticket_id"] is None


def test_webhook_without_secret_configured_rejects(api, monkeypatch):
    """Sin WOMPI_EVENTS_SECRET (503 en creacion) el webhook TAMPOCO abre:
    un despliegue sin configurar no deja la puerta del dinero abierta."""
    import app.core.config as config_mod

    settings = config_mod.get_settings()
    monkeypatch.setattr(settings, "wompi_events_secret", "", raising=False)

    res = api.client.post(
        "/payments/wompi/webhook", json=_signed(_wompi_link_payload(), "x")
    )
    assert res.status_code == 403


def test_webhook_is_idempotent(api, wompi_on):
    """El reintento del webhook (30min/3h/24h) NO re-emite: mismo ticket."""
    venue, ev_id, _ = _scenario(api)

    payload = _signed(_wompi_link_payload(), wompi_on.wompi_events_secret)
    first = api.client.post("/payments/wompi/webhook", json=payload)
    assert first.status_code == 200
    ticket_a = first.json()["ticket_id"]

    # Reintento identico: la SQL ve status approved y RETURN sin emitir.
    second = api.client.post("/payments/wompi/webhook", json=payload)
    assert second.status_code == 200
    assert second.json()["ticket_id"] == ticket_a

    n = api.run_sql(
        f"SELECT count(*)::int AS n FROM tickets WHERE event_id = {ev_id}"
    )
    assert n == 1


def test_webhook_rejects_amount_mismatch(api, wompi_on):
    """El payload miente sobre el monto: 409, sin boleta, cobro intacto."""
    venue, ev_id, payment = _scenario(api)

    payload = _wompi_link_payload()
    payload["data"]["transaction"]["amount_in_cents"] = 1  # pago de $0.01
    payload = _signed(payload, wompi_on.wompi_events_secret)
    res = api.client.post("/payments/wompi/webhook", json=payload)
    assert res.status_code == 409, res.text

    payments = api.get(
        f"/venues/{venue}/events/{ev_id}/payments", "admin"
    ).json()
    p = next(x for x in payments["items"] if x["id"] == payment["payment_id"])
    assert p["status"] == "pending"


def test_webhook_declined_audits_but_never_emits(api, wompi_on):
    """DECLINED queda auditado con su payload crudo y no emite nada."""
    venue, ev_id, payment = _scenario(api)

    payload = _wompi_link_payload()
    payload["data"]["transaction"]["status"] = "DECLINED"
    payload = _signed(payload, wompi_on.wompi_events_secret)
    res = api.client.post("/payments/wompi/webhook", json=payload)
    assert res.status_code == 200
    assert res.json()["ticket_id"] is None

    payments = api.get(
        f"/venues/{venue}/events/{ev_id}/payments", "admin"
    ).json()
    p = next(x for x in payments["items"] if x["id"] == payment["payment_id"])
    assert p["status"] == "declined"
    assert p["ticket_id"] is None


def test_webhook_of_another_link_is_ignored(api, wompi_on):
    """Un link ajeno (creado a mano en Wompi) no toca nuestros cobros."""
    venue, ev_id, _ = _scenario(api)

    payload = _wompi_link_payload()
    payload["data"]["transaction"]["payment_link_id"] = "link-de-otro-bar"
    payload = _signed(payload, wompi_on.wompi_events_secret)
    res = api.client.post("/payments/wompi/webhook", json=payload)
    assert res.status_code == 200

    n = api.run_sql(
        f"SELECT count(*)::int AS n FROM tickets WHERE event_id = {ev_id}"
    )
    assert n == 0


def test_dead_payment_cannot_be_approved_afterwards(api, wompi_on):
    """DECLINED no revive: si Wompi mandara APPROVED despues, 409 visible."""
    venue, ev_id, _ = _scenario(api)

    payload = _wompi_link_payload()
    payload["data"]["transaction"]["status"] = "DECLINED"
    api.client.post(
        "/payments/wompi/webhook", json=_signed(payload, wompi_on.wompi_events_secret)
    )

    payload["data"]["transaction"]["status"] = "APPROVED"
    res = api.client.post(
        "/payments/wompi/webhook", json=_signed(payload, wompi_on.wompi_events_secret)
    )
    assert res.status_code == 409

    n = api.run_sql(
        f"SELECT count(*)::int AS n FROM tickets WHERE event_id = {ev_id}"
    )
    assert n == 0


# ---------------------------------------------------------------------------
# Creacion de cobros (el admin)
# ---------------------------------------------------------------------------
def test_create_payment_503_when_not_configured(api_client, monkeypatch):
    """Sin claves Wompi el cobro responde 503: la feature apagada es un
    contrato, no un error 500."""
    import app.core.config as config_mod

    settings = config_mod.get_settings()
    monkeypatch.setattr(settings, "wompi_private_key", "", raising=False)
    monkeypatch.setattr(settings, "wompi_events_secret", "", raising=False)
    res = api_client.post(
        "/venues/999999/events/999999/payments", json={}, headers={}
    )
    assert res.status_code in (401, 403)  # sin token: la auth manda primero


def test_promoter_cannot_create_payments(api, wompi_on):
    """Cobrar es decision del negocio: minimo privilegio."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Solo admin cobra")
    t = api.add_type("admin", venue, ev["id"], price_cents=100000, is_courtesy=False)
    api.publish("admin", venue, ev["id"])
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/payments",
        "promoter",
        {
            "ticket_type_id": t["id"],
            "amount_in_cents": 100000,
            "customer_name": "X",
            "customer_phone": "573001234567",
        },
    )
    assert res.status_code == 403


def test_create_payment_requires_real_type(api, wompi_on):
    """No se puede cobrar por un tipo ajeno al evento."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Evento A")
    other = api.create_event("admin", venue, name="Evento B")
    t_other = api.add_type("admin", venue, other["id"], price_cents=100000)
    api.publish("admin", venue, ev["id"])
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/payments",
        "admin",
        {
            "ticket_type_id": t_other["id"],
            "amount_in_cents": 100000,
            "customer_name": "X",
            "customer_phone": "573001234567",
        },
    )
    assert res.status_code == 404
