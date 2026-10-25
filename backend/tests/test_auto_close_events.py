"""Cierre automatico de eventos vencidos (mig 020).

Un evento live cuyo ends_at paso quedaba "en puerta" para siempre si nadie
pulsaba "Terminar": la franja mentia y los KPIs del negocio se distorsionaban.
La funcion auto_close_expired_events() (SQL, idempotente) hace las
transiciones validas live->ended y published->ended; el endpoint de listado
de eventos la invoca como watchdog en cada lectura.

Desde la mig 034 el cierre tiene 6 h de GRACIA (ends_at es una estimacion del
organizador, no una orden de desalojo): por eso los tests vencen el evento 7 h
atras y no 1 h. La gracia en si se cubre en test_door_grace_and_sync.py.
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
                "UPDATE events SET ends_at = now() - interval '7 hours' WHERE id = %s",
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
                "UPDATE events SET ends_at = now() - interval '7 hours' WHERE id = %s",
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
                "UPDATE events SET ends_at = now() - interval '7 hours' WHERE id = %s",
                (scen["event"],),
            )
    events = api.get(f"/venues/{scen['venue']}/events", "admin").json()
    target = next(e for e in events if e["id"] == scen["event"])
    assert target["status"] == "ended"


def test_published_vencido_no_tumba_el_listado(api):
    """REGRESION del 500 de produccion (sep 2026).

    La watchdog intentaba published -> ended y el trigger events_check_transition
    (mig 005) lo rechazaba con invalid_transition: con UN solo evento publicado
    con ends_at vencido en la DB, TODO GET /events moria 500. Lo correcto:
    un published vencido (venta que cerro sin abrir puertas) va a CANCELLED,
    transicion que el trigger si acepta, y el listado sigue funcionando.
    """
    scen = api.scenario()
    # El evento del scenario queda PUBLISHED (sin abrir puertas) y se vence.
    with psycopg.connect(
        api.dsn, autocommit=True, row_factory=dict_row
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE events SET ends_at = now() - interval '7 hours' WHERE id = %s",
                (scen["event"],),
            )
    # Antes del fix: este GET lanzaba invalid_transition y respondia 500.
    res = api.get(f"/venues/{scen['venue']}/events", "admin")
    assert res.status_code == 200, res.text
    target = next(e for e in res.json() if e["id"] == scen["event"])
    assert target["status"] == "cancelled"
