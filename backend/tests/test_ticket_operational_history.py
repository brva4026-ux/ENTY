"""Expediente operativo de una boleta y resolución de pagos sin boleta.

Los cuatro escenarios que el equipo debe poder responder sin abrir la DB:
  1. compró y no le llegó la boleta (pago aprobado, emisión fallida);
  2. el QR fue rechazado o ya se había usado;
  3. la boleta se reemitió y el QR viejo murió;
  4. anulación/reembolso: quién, cuándo y por qué.
"""
import uuid

from tests.test_public_checkout import (
    _LINK,
    _checkout,
    _scenario,
    _signed_webhook,
    wompi_on,
)


def _history(api, venue, event, ticket, who="admin"):
    return api.get(f"/venues/{venue}/events/{event}/tickets/{ticket}/history", who)


def _paid_event(api, *, quantity=10):
    venue = api.world["venue_a"]
    event = api.create_event("admin", venue, name=f"Historial {uuid.uuid4().hex[:6]}")
    kind = api.add_type(
        "admin",
        venue,
        event["id"],
        name="General",
        price_cents=5000000,
        quantity=quantity,
        is_courtesy=False,
    )
    api.publish("admin", venue, event["id"])
    return venue, event["id"], kind["id"]


def _emit_paid(api, venue, event, kind, *, name="Ana Gómez", phone="3001234567"):
    res = api.post(
        f"/venues/{venue}/events/{event}/tickets",
        "admin",
        {
            "ticket_type_id": kind,
            "customer_name": name,
            "customer_phone": phone,
            "payment_method": "efectivo",
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_history_roles_and_ownership(api):
    venue, event, kind = _paid_event(api)
    ticket = _emit_paid(api, venue, event, kind)

    admin = _history(api, venue, event, ticket["ticket_id"], "admin")
    assert admin.status_code == 200, admin.text
    body = admin.json()
    assert body["viewer_role"] == "admin"
    assert body["can_reissue"] is True
    assert body["can_refund"] is True
    assert body["can_void"] is True
    assert body["customer_name"] == "Ana Gómez"
    assert body["payment_method"] == "efectivo"
    assert body["sale_channel"] == "venue"
    assert [e["kind"] for e in body["timeline"]][0] == "issued"
    assert body["timeline"][0]["actor_name"] == "Usuario admin"

    own = _history(api, venue, event, ticket["ticket_id"], "promoter")
    # El promotor no vendió esta boleta: solo Administración y el emisor.
    assert own.status_code == 403, own.text

    # Un promotor que sí la emitió ve su expediente, sin poderes de caja.
    venue_promo = api.world["venue_a"]
    ev = api.create_event("admin", venue_promo, name=f"Promo {uuid.uuid4().hex[:6]}")
    courtesy = api.add_type(
        "admin", venue_promo, ev["id"], quantity=10, is_courtesy=True
    )
    api.publish("admin", venue_promo, ev["id"])
    alloc = api.set_allocation(
        "admin",
        venue_promo,
        ev["id"],
        ticket_type_id=courtesy["id"],
        promoter_id=api.world["promoter"]["id"],
        capacity=5,
    )
    sold = api.emit(
        "promoter",
        venue_promo,
        ev["id"],
        ticket_type_id=courtesy["id"],
        allocation_id=alloc["id"],
    )
    promo = _history(api, venue_promo, ev["id"], sold["ticket_id"], "promoter")
    assert promo.status_code == 200, promo.text
    assert promo.json()["viewer_role"] == "promotor"
    assert promo.json()["can_reissue"] is True
    assert promo.json()["can_refund"] is False
    assert promo.json()["can_void"] is False

    other = _history(api, venue_promo, ev["id"], sold["ticket_id"], "promoter2")
    assert other.status_code == 403
    bouncer = _history(api, venue, event, ticket["ticket_id"], "bouncer")
    assert bouncer.status_code == 403


def test_history_shows_reissue_scan_and_duplicate(api):
    venue, event, kind = _paid_event(api)
    ticket = _emit_paid(api, venue, event, kind)

    # Abrir la ventana del QR: el escaneo debe pasar por la ruta normal, no
    # por el "forzar ingreso" de Administración.
    api.run_sql(
        f"UPDATE events SET starts_at=now(), ends_at=now()+interval '6 hours' "
        f"WHERE id={event}"
    )
    reissued = api.post(
        f"/venues/{venue}/events/{event}/tickets/{ticket['ticket_id']}/reissue",
        "admin",
        {"reason": "Perdió el WhatsApp"},
    )
    assert reissued.status_code == 200, reissued.text
    token = reissued.json()["raw_token"]

    first = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": token, "door_id": "puerta-1"},
    )
    assert first.status_code == 200, first.text
    second = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": token, "door_id": "puerta-1"},
    )
    assert second.status_code == 200, second.text

    body = _history(api, venue, event, ticket["ticket_id"]).json()
    kinds = [e["kind"] for e in body["timeline"]]
    assert "reissued" in kinds
    assert "scan_granted" in kinds
    assert "scan_duplicate" in kinds
    reissue = next(e for e in body["timeline"] if e["kind"] == "reissued")
    assert "anterior dejó de funcionar" in reissue["detail"]
    assert body["redeemed_at"] is not None
    assert body["redeemed_by_name"] == "Usuario admin"
    assert body["can_reissue"] is False
    assert body["can_refund"] is False


def test_history_shows_rejected_scan_wrong_type(api):
    venue, event, kind = _paid_event(api)
    other_kind = api.add_type(
        "admin",
        venue,
        event,
        name="VIP",
        price_cents=9000000,
        quantity=10,
        is_courtesy=False,
    )
    ticket = _emit_paid(api, venue, event, kind)
    api.run_sql(
        f"UPDATE events SET starts_at=now(), ends_at=now()+interval '6 hours' "
        f"WHERE id={event}"
    )

    res = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {
            "raw_token": ticket["raw_token"],
            "ticket_type_id": other_kind["id"],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["code"] == "WRONG_TYPE"

    body = _history(api, venue, event, ticket["ticket_id"]).json()
    rejected = next(e for e in body["timeline"] if e["kind"] == "scan_rejected")
    assert "otra localidad" in rejected["detail"]
    assert body["status"] == "issued"


def test_history_shows_void_and_refund_with_actor_and_reason(api):
    venue, event, kind = _paid_event(api)
    voided = _emit_paid(api, venue, event, kind, name="Anulada")
    refunded = _emit_paid(api, venue, event, kind, name="Reembolsada")

    res = api.post(
        f"/venues/{venue}/events/{event}/tickets/{voided['ticket_id']}/void",
        "admin",
        {"reason": "Error de digitación"},
    )
    assert res.status_code == 200, res.text
    void_history = _history(api, venue, event, voided["ticket_id"]).json()
    void_entry = next(e for e in void_history["timeline"] if e["kind"] == "voided")
    assert void_entry["detail"] == "Error de digitación"
    assert void_entry["actor_name"] == "Usuario admin"

    res = api.post(
        f"/venues/{venue}/events/{event}/tickets/{refunded['ticket_id']}/refund",
        "admin",
        {"reason": "No puede asistir", "amount_in_cents": 5000000},
    )
    assert res.status_code == 200, res.text
    refund_history = _history(api, venue, event, refunded["ticket_id"]).json()
    refund_entry = next(e for e in refund_history["timeline"] if e["kind"] == "refunded")
    assert refund_entry["amount_cents"] == 5000000
    assert refund_entry["detail"] == "No puede asistir"
    assert refund_history["status"] == "refunded"


def test_admin_resolves_paid_unfulfilled_payment(api, wompi_on):
    venue, event, kind = _scenario(api, quantity=1)
    first = _checkout(api, event, kind["id"])
    assert first.status_code == 201, first.text
    reference = first.json()["reference"]
    link_id = _LINK["id"]

    # La reserva caduca y otro comprador toma el último lugar.
    api.run_sql(
        "UPDATE ticket_payments SET reservation_expires_at=now()-interval '1 second' "
        f"WHERE reference='{reference}'"
    )
    second = _checkout(api, event, kind["id"])
    assert second.status_code == 201, second.text

    payload = _signed_webhook(
        wompi_on.wompi_events_secret, amount=5000000, link_id=link_id
    )
    assert api.client.post("/payments/wompi/webhook", json=payload).status_code == 200
    status = api.client.get(f"/public/checkout/{reference}").json()
    assert status["status"] == "paid_unfulfilled"
    assert status["ticket_id"] is None

    payment_id = api.run_sql(
        f"SELECT id FROM ticket_payments WHERE reference='{reference}'"
    )
    # Liberar el lugar que quedó reservado por el segundo checkout.
    api.run_sql(
        "UPDATE ticket_payments SET status='expired', reservation_expires_at=NULL "
        f"WHERE reference='{second.json()['reference']}'"
    )

    res = api.post(
        f"/venues/{venue}/events/{event}/payments/{payment_id}/fulfill", "admin"
    )
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["duplicate"] is False
    assert out["raw_token"]
    assert out["ticket_id"]

    # El pago original quedó conciliado y el precio es el cobrado.
    assert (
        api.run_sql(f"SELECT status FROM ticket_payments WHERE id={payment_id}")
        == "approved"
    )
    assert (
        api.run_sql(f"SELECT ticket_id FROM ticket_payments WHERE id={payment_id}")
        == out["ticket_id"]
    )
    assert (
        api.run_sql(
            f"SELECT price_cents_snapshot FROM tickets WHERE id={out['ticket_id']}"
        )
        == 5000000
    )
    assert (
        api.run_sql(f"SELECT sale_channel FROM tickets WHERE id={out['ticket_id']}")
        == "public"
    )

    # Reintentar no emite una segunda boleta ni entrega otro token.
    again = api.post(
        f"/venues/{venue}/events/{event}/payments/{payment_id}/fulfill", "admin"
    )
    assert again.status_code == 200, again.text
    assert again.json()["duplicate"] is True
    assert again.json()["raw_token"] is None
    assert (
        api.run_sql(f"SELECT count(*) FROM tickets WHERE event_id={event}") == 1
    )

    history = _history(api, venue, event, out["ticket_id"]).json()
    assert history["payment"]["status"] == "approved"
    assert {e["kind"] for e in history["timeline"]} >= {
        "issued",
        "payment_created",
        "payment_approved",
    }

    # El promotor no puede resolver cobros.
    assert (
        api.post(
            f"/venues/{venue}/events/{event}/payments/{payment_id}/fulfill",
            "promoter",
        ).status_code
        == 403
    )


def test_summary_reconciles_payments_and_refunds(api, wompi_on):
    venue, event, kind = _scenario(api, quantity=10)
    checkout = _checkout(api, event, kind["id"])
    assert checkout.status_code == 201, checkout.text
    payload = _signed_webhook(
        wompi_on.wompi_events_secret,
        amount=5000000,
        link_id=_LINK["id"],
    )
    assert api.client.post("/payments/wompi/webhook", json=payload).status_code == 200

    ticket_id = api.client.get(
        f"/public/checkout/{checkout.json()['reference']}"
    ).json()["ticket_id"]
    assert ticket_id

    refund = api.post(
        f"/venues/{venue}/events/{event}/tickets/{ticket_id}/refund",
        "admin",
        {"reason": "Devolución de prueba", "amount_in_cents": 5000000},
    )
    assert refund.status_code == 200, refund.text

    summary = api.get(f"/venues/{venue}/events/{event}/summary", "admin")
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["payments"]["approved_count"] == 1
    assert body["payments"]["approved_cents"] == 5000000
    assert body["refunds"]["count"] == 1
    assert body["refunds"]["amount_cents"] == 5000000
    assert body["revenue_cents"] == 0

    report = api.get(f"/venues/{venue}/events/{event}/report", "admin").json()
    assert report["refunded_cents"] == 5000000

    csv_res = api.get(f"/venues/{venue}/events/{event}/summary.csv", "admin")
    assert csv_res.status_code == 200
    assert "Dinero reembolsado" in csv_res.text
    assert "Aprobados con boleta" in csv_res.text
