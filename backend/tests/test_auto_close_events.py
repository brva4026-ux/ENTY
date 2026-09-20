"""Cierre automatico de eventos vencidos (mig 020).

Un evento live cuyo ends_at paso quedaba "en puerta" para siempre si nadie
pulsaba "Terminar": la franja mentia y los KPIs del negocio se distorsionaban.
La funcion auto_close_expired_events() (SQL, idempotente) hace las
transiciones validas live->ended y published->ended; el endpoint de listado
de eventos la invoca como watchdog en cada lectura.
"""
import psycopg
import pytest
from psycopg.rows import dict_row

pytestmark = pytest.mark.usefixtures("db")


def test_live_vencido_se_cierra(api):
    """El caso central: live con ends_at pasado -> ended con UNA llamada."""
    scen = api.scenario()
    # Publicado -> live (la transicion valida) y vencido hace 1 hora.
    api.post(f"/venues/{scen['venue']}/events/{scen['event']}/live", "admin")
    with psycopg.connect(
        api.dsn, autocommit=True, row_factory=dict_row
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE events SET ends_at = now() - interval '1 hour' WHERE id = %s",
                (scen["event"],),
            )
    closed = api.run_sql("SELECT auto_close_expired_events()")
    assert closed >= 1
    st = api.event_status(scen["venue"], scen["event"])
    assert st == "ended"


def test_no_cierra_sin_ends_at(api):
    """Un live SIN fecha de cierre no se toca: el sistema no adivina."""
    scen = api.scenario()
    api.post(f"/venues/{scen['venue']}/events/{scen['event']}/live", "admin")
    with psycopg.connect(
        api.dsn, autocommit=True, row_factory=dict_row
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE events SET ends_at = NULL WHERE id = %s",
                (scen["event"],),
            )
    api.run_sql("SELECT auto_close_expired_events()")
    st = api.event_status(scen["venue"], scen["event"])
    assert st == "live"


def test_es_idempotente(api):
    """Llamarla dos veces no rompe ni re-abre: la segunda cierra 0."""
    scen = api.scenario()
    api.post(f"/venues/{scen['venue']}/events/{scen['event']}/live", "admin")
    with psycopg.connect(
        api.dsn, autocommit=True, row_factory=dict_row
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE events SET ends_at = now() - interval '1 hour' WHERE id = %s",
                (scen["event"],),
            )
    primera = api.run_sql("SELECT auto_close_expired_events()")
    segunda = api.run_sql("SELECT auto_close_expired_events()")
    assert primera >= 1
    assert segunda == 0  # ya no queda nada vencido
    st = api.event_status(scen["venue"], scen["event"])
    assert st == "ended"


def test_watchdog_en_listado(api, api_client):
    """El GET /events dispara el watchdog: el listado nunca muestra un
    live vencido como tal."""
    scen = api.scenario()
    api.post(f"/venues/{scen['venue']}/events/{scen['event']}/live", "admin")
    with psycopg.connect(
        api.dsn, autocommit=True, row_factory=dict_row
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE events SET ends_at = now() - interval '1 hour' WHERE id = %s",
                (scen["event"],),
            )
    events = api.get(f"/venues/{scen['venue']}/events", "admin").json()
    target = next(e for e in events if e["id"] == scen["event"])
    assert target["status"] == "ended"
