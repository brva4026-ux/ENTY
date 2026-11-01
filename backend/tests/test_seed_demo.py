"""El seed demo se auto-repara: un evento demo vencido vuelve a ser futuro.

Bug real (produccion, nov-2026): la vitrina publica `/inicio` quedaba VACIA.
No era el endpoint — `/public/events` filtra `status IN ('published','live')`
AND `starts_at >= now()`, y el filtro es correcto. El evento demo del seed se
insertaba UNA sola vez (`_ensure_event` salia sin tocarlo si ya existia), asi
que a los pocos dias su `starts_at` quedaba en el pasado. Volver a sembrar
(`POST /seed`) no lo revivia: el seed veia el evento y salia.

Estos tests fijan el contrato nuevo: sembrar dos veces deja el evento demo
FUTURO y VISIBLE en el catalogo publico. La segunda siembra es la que importa:
es la que antes no hacia nada.
"""
import asyncio
import os

import psycopg
from psycopg.rows import dict_row

from app.routers.seed import seed_demo_data


def _dsn() -> str:
    return os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
    )


def _seed() -> dict:
    async def _run():
        conn = await psycopg.AsyncConnection.connect(
            _dsn(), autocommit=True, row_factory=dict_row
        )
        try:
            return await seed_demo_data(conn)
        finally:
            await conn.close()

    return asyncio.run(_run())


def _event_row(dbcur, event_id: int) -> dict:
    return dbcur.execute(
        "SELECT id, name, status, starts_at, starts_at > now() AS futuro "
        "FROM events WHERE id = %s",
        (event_id,),
    ).fetchone()


def test_reseed_refreshes_a_stale_demo_event(db, dbcur):
    """El evento demo vencido vuelve a ser futuro al re-sembrar.

    Se envejece a mano (starts_at en el pasado) para simular el paso del
    tiempo, y se vuelve a sembrar. Antes del fix la segunda siembra devolvia el
    mismo id sin tocar la fecha y el evento seguia invisible en la vitrina.
    """
    first = _seed()
    event_id = first["event_id"]

    # Simula el paso del tiempo: el evento demo quedo en el pasado.
    dbcur.execute(
        "UPDATE events SET starts_at = now() - interval '30 days' WHERE id = %s",
        (event_id,),
    )
    assert _event_row(dbcur, event_id)["futuro"] is False, "el escenario de partida debe estar vencido"

    _seed()  # segunda siembra: la que antes no hacia nada

    row = _event_row(dbcur, event_id)
    assert row["id"] == event_id, "re-sembrar no debe duplicar el evento demo"
    assert row["futuro"] is True, "re-sembrar debe re-fechar el evento demo al futuro"


def test_reseed_does_not_duplicate_the_demo_event(db, dbcur):
    """Sembrar N veces deja UN solo evento demo en la venue del seed.

    Se acota a la venue del seed: otros tests de la suite crean eventos con el
    mismo nombre en SUS propias venues, y contarlos globalmente seria fragil.
    """
    first = _seed()
    _seed()
    _seed()

    n = dbcur.execute(
        "SELECT count(*) AS n FROM events WHERE name = 'Noche Electrónica' AND venue_id = %s",
        (first["venue_id"],),
    ).fetchone()["n"]
    assert n == 1, f"el seed no debe duplicar el evento demo (hay {n})"


def test_terminal_demo_event_is_replaced_not_revived(db, dbcur):
    """Si el demo quedo terminal (ended), re-sembrar crea uno NUEVO publicado.

    Es el caso real de produccion: el evento demo (id 2) estaba 'ended' y
    vencido. No se puede republicar (el trigger `events_check_transition` solo
    permite ended->live, no ended->published), asi que el seed inserta uno
    nuevo en vez de revivir la historia.
    """
    first = _seed()
    event_id = first["event_id"]
    venue_id = first["venue_id"]

    # Lleva el demo a un estado terminal por la ruta valida del trigger.
    dbcur.execute("UPDATE events SET status = 'live' WHERE id = %s", (event_id,))
    dbcur.execute("UPDATE events SET status = 'ended' WHERE id = %s", (event_id,))

    _seed()

    rows = dbcur.execute(
        "SELECT id, status, starts_at > now() AS futuro FROM events "
        "WHERE name = 'Noche Electrónica' AND venue_id = %s AND status IN ('published','live')",
        (venue_id,),
    ).fetchall()
    assert len(rows) == 1, f"debe quedar exactamente un demo publicable (hay {len(rows)})"
    assert rows[0]["id"] != event_id, "no debe resucitar el demo terminal: crea uno nuevo"
    assert rows[0]["futuro"] is True, "el demo nuevo debe nacer futuro"


def test_demo_event_is_visible_in_the_public_catalog_after_reseed(db, dbcur, api_client):
    """El evento demo queda VISIBLE en `/public/events` tras re-sembrar.

    Es el sintoma reportado: la vitrina vacia. Se filtra por la ciudad del
    evento para que la asercion no dependa de la ventana global de 50.
    """
    seeded = _seed()
    event_id = seeded["event_id"]
    dbcur.execute(
        "UPDATE events SET starts_at = now() - interval '30 days' WHERE id = %s",
        (event_id,),
    )

    city = f"CiudadSeed{event_id}"
    dbcur.execute("UPDATE events SET location = %s WHERE id = %s", (city, event_id))

    # Vencido: el catalogo no lo muestra.
    antes = api_client.get("/public/events", params={"city": city}).json()
    assert all(e["id"] != event_id for e in antes["events"]), "vencido no debe listarse"

    _seed()

    despues = api_client.get("/public/events", params={"city": city}).json()
    assert any(e["id"] == event_id for e in despues["events"]), (
        "tras re-sembrar el evento demo debe volver a la vitrina"
    )
