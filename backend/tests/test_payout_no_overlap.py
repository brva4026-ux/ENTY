"""Liquidaciones: el rango no puede pisar a otro (doble pago), ni siquiera
bajo concurrencia.

`generate_payout` validaba el solape leyendo `max(period_end)` e insertando
después, sin lock: dos admins concurrentes pasaban los dos. El índice único
`idx_payouts_unique_period` solo cubría `period_start` IDÉNTICO, así que un
solape con otro inicio pasaba limpio. La mig 045 mueve la invariante a la DB
(exclusion constraint), que rechaza el solape incluso en el INSERT concurrente.
"""
import psycopg
import pytest


def _generate(api, venue, promoter_id, start, end):
    return api.post(
        f"/venues/{venue}/payouts/generate", "admin",
        {"promoter_id": promoter_id, "period_start": start, "period_end": end},
    )


def test_overlap_rejected_at_db_level(api):
    """La exclusion constraint rechaza el solape aunque se salte el endpoint."""
    scen = api.scenario()
    venue = scen["venue"]
    promoter = api.world["promoter"]["id"]

    res = _generate(api, venue, promoter, "2026-01-01", "2026-01-31")
    assert res.status_code == 201, res.text

    # Inserción directa (sin pasar por la validación del endpoint): la DB debe
    # rechazarla igual. Sin la constraint, esto colaba como doble pago.
    with pytest.raises(psycopg.errors.ExclusionViolation):
        api.run_sql(
            "INSERT INTO promoter_payouts "
            "(venue_id, promoter_id, period_start, period_end) "
            "VALUES (%d, %d, '2026-01-15', '2026-02-15')"
            % (venue, promoter)
        )


def test_concurrent_generate_does_not_double_pay(api):
    """Dos generaciones simultáneas del mismo promotor: una gana, la otra 409."""
    from concurrent.futures import ThreadPoolExecutor

    scen = api.scenario()
    venue = scen["venue"]
    promoter = api.world["promoter"]["id"]
    # Token antes de concurrir: el login no debe ser parte de la carrera.
    api.token("admin")

    def call(_):
        return _generate(api, venue, promoter, "2026-03-01", "2026-03-31")

    with ThreadPoolExecutor(max_workers=2) as pool:
        codes = sorted(r.status_code for r in pool.map(call, range(2)))

    # Una creada, una rechazada por solape. Nunca dos.
    assert codes == [201, 409], codes
    rows = api.run_sql(
        "SELECT count(*) FROM promoter_payouts "
        "WHERE venue_id = %d AND promoter_id = %d "
        "AND period_start = '2026-03-01'" % (venue, promoter)
    )
    assert rows == 1, f"se crearon {rows} liquidaciones para el mismo rango"


def test_concurrent_review_pays_once(api):
    """Dos reviews simultáneos de la misma liquidación: solo uno la cierra."""
    from concurrent.futures import ThreadPoolExecutor

    scen = api.scenario()
    venue = scen["venue"]
    res = _generate(api, venue, api.world["promoter"]["id"],
                    "2026-05-01", "2026-05-31")
    payout_id = res.json()["id"]
    api.token("admin")

    def call(_):
        return api.post(
            f"/venues/{venue}/payouts/{payout_id}/review", "admin",
            {"action": "pay", "paid_cents": 10000, "note": "doble clic"},
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        codes = sorted(r.status_code for r in pool.map(call, range(2)))

    # Una paga, la otra rebota con 409 (ya cerrada). Nunca dos pagos.
    assert codes == [200, 409], codes
