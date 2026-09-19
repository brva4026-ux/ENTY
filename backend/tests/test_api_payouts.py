"""Tests de liquidaciones de promotores (mig 010).

Transplante de la disciplina payment_issues de unicall-blue:
- el agregado sale de tickets REALES del periodo (boletas vivas),
- la comisión se congela al cierre,
- rangos secuenciales (no solapables),
- disputa del promotor y resolución del admin,
- inmutabilidad de liquidaciones cerradas.
"""
from datetime import date

# ---------------------------------------------------------------------------
# Generación
# ---------------------------------------------------------------------------
def test_generate_payout_aggregates_real_sales(api):
    """El monto sale de los tickets emitidos por el promotor en el periodo."""
    scen = api.scenario()
    venue = scen["venue"]

    # 2 cortesías emitidas por el promotor (snapshot 0 => recaudo 0).
    alloc_id = scen["allocation"]["id"]
    api.emit("promoter", venue, scen["event"],
             ticket_type_id=scen["type"], allocation_id=alloc_id, customer_name="A")
    api.emit("promoter", venue, scen["event"],
             ticket_type_id=scen["type"], allocation_id=alloc_id, customer_name="B")

    res = api.post(
        f"/venues/{venue}/payouts/generate", "admin",
        {
            "promoter_id": api.world["promoter"]["id"],
            "period_start": "2026-01-01",
            "period_end": date.today().isoformat(),
        },
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["tickets_count"] == 2
    assert body["revenue_cents"] == 0  # cortesías
    assert body["status"] == "pending"


def test_generate_payout_with_revenue_and_commission(api):
    """Recaudo real x comisión = comisión calculada y congelada al cierre."""
    scen = api.scenario()
    venue = scen["venue"]

    # Comisión de la venue al 10%.
    res = api.patch("/auth/venues/{v}".format(v=venue), "admin", {"commission_pct": 10})
    assert res.status_code == 200, res.text
    assert res.json()["commission_pct"] == 10

    # Evento con tipo pagado y cupo propio para el promotor.
    ev = api.create_event("admin", venue, name="Comisionadas")
    t = api.add_type("admin", venue, ev["id"], name="Pago",
                     price_cents=30000, quantity=50, is_courtesy=False)
    api.publish("admin", venue, ev["id"])
    # Venta directa del promotor: boleta PAGADA sin cupo (la DB lo exige
    # para tipos pagados) pero atribuida a sold_by_user_id = promotor.
    for name in ("Uno", "Dos"):
        res = api.post(
            f"/venues/{venue}/events/{ev['id']}/tickets", "promoter",
            {"ticket_type_id": t["id"], "customer_name": name,
             "customer_phone": "3001234567"},
        )
        assert res.status_code == 201, res.text

    res = api.post(
        f"/venues/{venue}/payouts/generate", "admin",
        {
            "promoter_id": api.world["promoter"]["id"],
            "period_start": "2026-01-01",
            "period_end": date.today().isoformat(),
        },
    )
    assert res.status_code == 201, res.text
    body = res.json()
    # 2 x $300.00 => recaudo 60000 cents; comisión 10% => 6000 cents.
    assert body["tickets_count"] == 2
    assert body["revenue_cents"] == 60000
    assert body["commission_pct"] == 10
    assert body["commission_cents"] == 6000

    # El detalle del promotor (módulo Equipo) refleja el mismo recaudo.
    stats = api.get(f"/venues/{venue}/users/stats", "admin").json()
    promoter = next(m for m in stats["members"] if m["email"] == api.world["promoter"]["email"])
    assert promoter["quota"]["revenue_cents"] == 60000


def test_generate_payout_overlapping_range_rejected(api):
    """No se pueden generar rangos que se pisen (doble pago)."""
    scen = api.scenario()
    venue = scen["venue"]

    res = api.post(
        f"/venues/{venue}/payouts/generate", "admin",
        {
            "promoter_id": api.world["promoter"]["id"],
            "period_start": "2026-01-01",
            "period_end": "2026-01-31",
        },
    )
    assert res.status_code == 201

    # Solape total y parcial: ambos rechazados.
    for start, end in (("2026-01-15", "2026-02-15"), ("2026-01-01", "2026-03-01")):
        res = api.post(
            f"/venues/{venue}/payouts/generate", "admin",
            {
                "promoter_id": api.world["promoter"]["id"],
                "period_start": start,
                "period_end": end,
            },
        )
        assert res.status_code == 409, f"{start}..{end} debe solapar"

    # Rango posterior válido: aceptado.
    res = api.post(
        f"/venues/{venue}/payouts/generate", "admin",
        {
            "promoter_id": api.world["promoter"]["id"],
            "period_start": "2026-02-01",
            "period_end": "2026-02-28",
        },
    )
    assert res.status_code == 201


def test_generate_payout_promoter_not_in_venue(api):
    """Solo se liquida a quien es promotor de ESA venue."""
    scen = api.scenario()
    res = api.post(
        f"/venues/{scen['venue']}/payouts/generate", "admin",
        {"promoter_id": 999999, "period_start": "2026-01-01", "period_end": "2026-01-31"},
    )
    assert res.status_code == 404


def test_generate_payout_invalid_range(api):
    scen = api.scenario()
    res = api.post(
        f"/venues/{scen['venue']}/payouts/generate", "admin",
        {
            "promoter_id": api.world["promoter"]["id"],
            "period_start": "2026-02-01",
            "period_end": "2026-01-01",
        },
    )
    assert res.status_code == 422


# ---------------------------------------------------------------------------
# Permisos
# ---------------------------------------------------------------------------
def test_payout_permissions(api):
    scen = api.scenario()

    assert api.post(
        f"/venues/{scen['venue']}/payouts/generate", "promoter",
        {"promoter_id": api.world["promoter"]["id"],
         "period_start": "2026-01-01", "period_end": "2026-01-31"},
    ).status_code == 403

    assert api.get(f"/venues/{scen['venue']}/payouts", "promoter").status_code == 403

    # El promotor SÍ ve las suyas.
    assert api.get(f"/venues/{scen['venue']}/payouts/mine", "promoter").status_code == 200


# ---------------------------------------------------------------------------
# Disputa + revisión (el ciclo de unicall-blue)
# ---------------------------------------------------------------------------
def test_dispute_and_review_cycle(api):
    scen = api.scenario()
    venue = scen["venue"]

    res = api.post(
        f"/venues/{venue}/payouts/generate", "admin",
        {"promoter_id": api.world["promoter"]["id"],
         "period_start": "2026-03-01", "period_end": "2026-03-31"},
    )
    payout_id = res.json()["id"]

    # Disputa del promotor (razón mínima 10 chars).
    res = api.post(
        f"/venues/{venue}/payouts/{payout_id}/dispute", "promoter",
        {"reason": "Faltaron 3 boletas que emití el viernes"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "disputed"
    assert "viernes" in res.json()["disputed_reason"]

    # No se puede disputar dos veces.
    res = api.post(
        f"/venues/{venue}/payouts/{payout_id}/dispute", "promoter",
        {"reason": "otra disputa tras estar disputada"},
    )
    assert res.status_code == 409

    # Admin paga con ajuste + nota.
    res = api.post(
        f"/venues/{venue}/payouts/{payout_id}/review", "admin",
        {"action": "pay", "paid_cents": 50000, "note": "Verificado contra el scan"},
    )
    assert res.status_code == 200, res.text
    closed = res.json()
    assert closed["status"] == "paid"
    assert closed["paid_cents"] == 50000
    assert closed["review_note"] == "Verificado contra el scan"

    # Cerrada = inmutable: ni pagar de nuevo ni rechazar.
    for action in ("pay", "reject"):
        res = api.post(
            f"/venues/{venue}/payouts/{payout_id}/review", "admin",
            {"action": action, "note": "intento tardío"},
        )
        assert res.status_code == 409


def test_reject_requires_note(api):
    scen = api.scenario()
    venue = scen["venue"]

    res = api.post(
        f"/venues/{venue}/payouts/generate", "admin",
        {"promoter_id": api.world["promoter"]["id"],
         "period_start": "2026-04-01", "period_end": "2026-04-30"},
    )
    payout_id = res.json()["id"]

    res = api.post(
        f"/venues/{venue}/payouts/{payout_id}/review", "admin",
        {"action": "reject"},
    )
    assert res.status_code == 422  # sin nota no se rechaza

    res = api.post(
        f"/venues/{venue}/payouts/{payout_id}/review", "admin",
        {"action": "reject", "note": "Boletas anuladas por fraude"},
    )
    assert res.status_code == 200
    assert res.json()["status"] == "rejected"


def test_promoter_cannot_dispute_others_payout(api):
    """Un promotor de otra venue no disputa liquidaciones ajenas (404 por
    aislamiento de venue; el mismatch de dueño daría 403)."""
    scen = api.scenario()
    venue = scen["venue"]

    res = api.post(
        f"/venues/{venue}/payouts/generate", "admin",
        {"promoter_id": api.world["promoter"]["id"],
         "period_start": "2026-05-01", "period_end": "2026-05-31"},
    )
    payout_id = res.json()["id"]

    # El bouncer no es promotor: 403 por rol.
    res = api.post(
        f"/venues/{venue}/payouts/{payout_id}/dispute", "bouncer",
        {"reason": "intento desde un rol que no es promotor"},
    )
    assert res.status_code == 403
