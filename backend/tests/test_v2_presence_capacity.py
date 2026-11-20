"""Las dos pruebas que el prompt maestro V2 exige como evidencia central.

1. Vender el último lugar sin sobreventa.
2. En la puerta, escanear la misma boleta desde dos puertas a la vez y
   admitir un solo ingreso.

(1) ya estaba cubierto por `test_race_redeem` y `reserve_ticket_payment`.
(2) también, pero aquí se prueba la versión REAL del enunciado: dos puertas
físicas distintas, no doce conexiones del mismo operador. Y se añade lo que
faltaba: el aforo.

Este archivo cubre lo que la migración 052-054 introduce:
  * el aforo se respeta al ADMITIR (antes solo al emitir),
  * la presencia (dentro/fuera) es la fuente de verdad de la ocupación,
  * una salida libera lugar y permite el reingreso si el evento lo permite.
"""
import asyncio
import os
import secrets

import psycopg
from psycopg.rows import dict_row

DSN = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
)


def _emit(cur, event_id, type_id, admin_id, name="Asistente"):
    token = secrets.token_urlsafe(24)
    cur.execute(
        "SELECT emit_ticket(%s, %s, NULL, %s, %s, %s, NULL, NULL)",
        (event_id, type_id, admin_id, name, token),
    )
    return token, cur.fetchone()["emit_ticket"]


def _open_event(cur, event_id, **kw):
    """Evento en curso: ya abrió la ventana del QR."""
    cur.execute(
        "UPDATE events SET starts_at = now() - interval '2 hours' WHERE id = %s",
        (event_id,),
    )
    for col, val in kw.items():
        cur.execute(f"UPDATE events SET {col} = %s WHERE id = %s", (val, event_id))


def test_two_doors_same_ticket_only_one_enters(api):
    """Dos puertas escanean la misma boleta a la vez: 1 GRANTED, 1 rechazo.

    Es el caso del enunciado. Las dos puertas son operadores distintos
    (dos usuarios de staff), cada uno en su propia transacción.
    """
    scen = api.scenario()
    admin_id = api.world["admin"]["id"]
    bouncer_b = api.world["promoter"]["id"]

    with psycopg.connect(DSN, autocommit=True, row_factory=dict_row) as setup:
        with setup.cursor() as cur:
            _open_event(cur, scen["event"])
            token, ticket_id = _emit(cur, scen["event"], scen["type"], admin_id)
            assert ticket_id

    async def door(user_id: int, door: str) -> str:
        conn = await psycopg.AsyncConnection.connect(DSN, autocommit=True)
        try:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT redeem_ticket(%s, %s, %s, NULL, NULL, %s)",
                    (scen["event"], token, user_id, door),
                )
                row = await cur.fetchone()
                return row[0]
        finally:
            await conn.close()

    async def both():
        return await asyncio.gather(
            door(admin_id, "puerta-norte"),
            door(bouncer_b, "puerta-sur"),
        )

    r1, r2 = asyncio.run(both())
    results = [r1, r2]

    assert results.count("GRANTED") == 1, (
        f"DOBLE INGRESO: esperaba 1 GRANTED y hubo {results.count('GRANTED')} ({results})"
    )
    assert sorted(results) == ["ALREADY_REDEEMED", "GRANTED"], results

    # Una sola persona adentro, sin importar cuántas puertas escanearon.
    with psycopg.connect(DSN, autocommit=True, row_factory=dict_row) as conn:
        occ = conn.execute(
            "SELECT * FROM event_occupancy(%s)", (scen["event"],)
        ).fetchone()
    assert occ["inside"] == 1, occ
    assert occ["unique_admitted"] == 1, occ


def test_capacity_is_enforced_at_the_door(api):
    """Aforo lleno en la puerta: rechaza y NO consume la boleta.

    El bug que cierra la 053: se emitían 3 boletas con capacidad 10 y luego
    el organizador bajaba el aforo a 2 (o el recinto se reconfigura). Las 3
    boletas seguían siendo válidas y las 3 entraban. Ahora la tercera recibe
    CAPACITY_REACHED, y su QR sigue sirviendo para cuando alguien salga.

    Nota: la emisión ya estaba protegida (emit_ticket rechaza pasarse de
    capacity), así que el escenario se construye emitiendo y luego bajando
    el aforo, que es como ocurre en la realidad.
    """
    scen = api.scenario(capacity=10, type_quantity=10)
    admin_id = api.world["admin"]["id"]

    with psycopg.connect(DSN, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            _open_event(cur, scen["event"])
            tokens = [_emit(cur, scen["event"], scen["type"], admin_id, f"P{i}")[0]
                      for i in range(3)]
            # El recinto se reconfigura: el aforo baja a 2. El trigger
            # trg_events_check_capacity impide bajarlo por debajo de lo
            # emitido (defensa correcta del panel), así que una
            # reconfiguración real llega por mantenimiento: se simula
            # desactivando la guarda, como haría un DBA.
            cur.execute("ALTER TABLE events DISABLE TRIGGER trg_events_check_capacity")
            cur.execute("UPDATE events SET capacity = 2 WHERE id = %s", (scen["event"],))
            cur.execute("ALTER TABLE events ENABLE TRIGGER trg_events_check_capacity")

        codes = []
        for t in tokens:
            codes.append(conn.execute(
                "SELECT redeem_ticket(%s, %s, %s)", (scen["event"], t, admin_id)
            ).fetchone()["redeem_ticket"])

        assert codes == ["GRANTED", "GRANTED", "CAPACITY_REACHED"], codes

        # La boleta rechazada por aforo NO quedó consumida.
        t3 = conn.execute(
            "SELECT status FROM tickets WHERE token_hash = encode(digest(%s,'sha256'),'hex')",
            (tokens[2],),
        ).fetchone()
        assert t3["status"] == "issued", t3

        occ = conn.execute("SELECT * FROM event_occupancy(%s)", (scen["event"],)).fetchone()
        assert occ["inside"] == 2, occ
        assert occ["capacity"] == 2, occ


def test_exit_frees_a_seat_and_allows_the_waiting_ticket(api):
    """Alguien sale, y la boleta que fue rechazada por aforo ahora entra.

    Es el ciclo completo: lleno -> rechazo -> salida -> admisión. Sin esto,
    el tope de aforo bloquearía el recinto para siempre.
    """
    scen = api.scenario(capacity=10, type_quantity=10)
    admin_id = api.world["admin"]["id"]

    with psycopg.connect(DSN, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            _open_event(cur, scen["event"])
            t1, _ = _emit(cur, scen["event"], scen["type"], admin_id, "Primero")
            t2, _ = _emit(cur, scen["event"], scen["type"], admin_id, "Segundo")
            cur.execute("ALTER TABLE events DISABLE TRIGGER trg_events_check_capacity")
            cur.execute("UPDATE events SET capacity = 1 WHERE id = %s", (scen["event"],))
            cur.execute("ALTER TABLE events ENABLE TRIGGER trg_events_check_capacity")

        assert conn.execute(
            "SELECT redeem_ticket(%s, %s, %s)", (scen["event"], t1, admin_id)
        ).fetchone()["redeem_ticket"] == "GRANTED"
        assert conn.execute(
            "SELECT redeem_ticket(%s, %s, %s)", (scen["event"], t2, admin_id)
        ).fetchone()["redeem_ticket"] == "CAPACITY_REACHED"

        assert conn.execute(
            "SELECT register_exit(%s, %s, %s)", (scen["event"], t1, admin_id)
        ).fetchone()["register_exit"] == "EXITED"

        # Ahora hay lugar: la segunda boleta entra.
        assert conn.execute(
            "SELECT redeem_ticket(%s, %s, %s)", (scen["event"], t2, admin_id)
        ).fetchone()["redeem_ticket"] == "GRANTED"

        occ = conn.execute("SELECT * FROM event_occupancy(%s)", (scen["event"],)).fetchone()
        assert occ["inside"] == 1, occ
        assert occ["exits"] == 1, occ
        assert occ["unique_admitted"] == 2, occ


def test_exit_is_idempotent(api):
    """Salir dos veces no descuenta dos veces (el operador repite el escaneo)."""
    scen = api.scenario()
    admin_id = api.world["admin"]["id"]

    with psycopg.connect(DSN, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            _open_event(cur, scen["event"])
            token, _ = _emit(cur, scen["event"], scen["type"], admin_id)

        conn.execute("SELECT redeem_ticket(%s, %s, %s)", (scen["event"], token, admin_id))
        first = conn.execute(
            "SELECT register_exit(%s, %s, %s)", (scen["event"], token, admin_id)
        ).fetchone()["register_exit"]
        second = conn.execute(
            "SELECT register_exit(%s, %s, %s)", (scen["event"], token, admin_id)
        ).fetchone()["register_exit"]

        assert first == "EXITED", first
        assert second == "ALREADY_OUTSIDE", second
        occ = conn.execute("SELECT * FROM event_occupancy(%s)", (scen["event"],)).fetchone()
        assert occ["exits"] == 1, occ
        assert occ["inside"] == 0, occ


def test_reentry_requires_event_permission(api):
    """Reingreso: bloqueado por defecto, permitido si el evento lo habilita."""
    scen = api.scenario()
    admin_id = api.world["admin"]["id"]

    with psycopg.connect(DSN, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            _open_event(cur, scen["event"])
            token, _ = _emit(cur, scen["event"], scen["type"], admin_id)

        conn.execute("SELECT redeem_ticket(%s, %s, %s)", (scen["event"], token, admin_id))
        conn.execute("SELECT register_exit(%s, %s, %s)", (scen["event"], token, admin_id))

        # Por defecto NO se permite reingreso.
        assert conn.execute(
            "SELECT redeem_ticket(%s, %s, %s)", (scen["event"], token, admin_id)
        ).fetchone()["redeem_ticket"] == "ALREADY_REDEEMED"

        # El organizador lo habilita.
        conn.execute("UPDATE events SET allow_reentry = true WHERE id = %s", (scen["event"],))

        assert conn.execute(
            "SELECT redeem_ticket(%s, %s, %s)", (scen["event"], token, admin_id)
        ).fetchone()["redeem_ticket"] == "GRANTED"

        occ = conn.execute("SELECT * FROM event_occupancy(%s)", (scen["event"],)).fetchone()
        assert occ["inside"] == 1, occ
        assert occ["reentries"] == 1, occ
        assert occ["unique_admitted"] == 1, occ


def test_zone_capacity_is_enforced(api):
    """Tope propio de una zona: la zona se llena antes que el evento."""
    scen = api.scenario(capacity=50, type_quantity=5)
    admin_id = api.world["admin"]["id"]

    with psycopg.connect(DSN, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            _open_event(cur, scen["event"])
            cur.execute(
                "UPDATE ticket_types SET access_capacity = 1 WHERE id = %s",
                (scen["type"],),
            )
            t1, _ = _emit(cur, scen["event"], scen["type"], admin_id, "Z1")
            t2, _ = _emit(cur, scen["event"], scen["type"], admin_id, "Z2")

        assert conn.execute(
            "SELECT redeem_ticket(%s, %s, %s)", (scen["event"], t1, admin_id)
        ).fetchone()["redeem_ticket"] == "GRANTED"
        assert conn.execute(
            "SELECT redeem_ticket(%s, %s, %s)", (scen["event"], t2, admin_id)
        ).fetchone()["redeem_ticket"] == "ZONE_CAPACITY_REACHED"


def test_last_seat_under_concurrency_no_oversell(api):
    """Último lugar, N compradores simultáneos: exactamente uno lo gana.

    Es la prueba 1 del prompt, sobre la emisión real (no el escaneo).
    """
    scen = api.scenario(capacity=50, type_quantity=50, alloc_capacity=50)
    admin_id = api.world["admin"]["id"]

    with psycopg.connect(DSN, autocommit=True, row_factory=dict_row) as setup:
        setup.execute(
            "UPDATE events SET starts_at = now() - interval '2 hours' WHERE id = %s",
            (scen["event"],),
        )
        # Se vendieron 49: queda UN lugar. El tipo se agota con él, así que
        # se limita también el cupo del tipo para que la carrera sea por el
        # último asiento y no por cupo de promotor.
        for i in range(49):
            token = secrets.token_urlsafe(24)
            setup.execute(
                "SELECT emit_ticket(%s, %s, NULL, %s, %s, %s, NULL, NULL)",
                (scen["event"], scen["type"], admin_id, f"Pre{i}", token),
            )
        setup.execute("UPDATE ticket_types SET quantity = 50 WHERE id = %s", (scen["type"],))

    n = 8

    async def buy(i: int) -> str:
        conn = await psycopg.AsyncConnection.connect(DSN, autocommit=True)
        try:
            async with conn.cursor() as cur:
                token = secrets.token_urlsafe(24)
                try:
                    await cur.execute(
                        "SELECT emit_ticket(%s, %s, NULL, %s, %s, %s, NULL, NULL)",
                        (scen["event"], scen["type"], admin_id, f"C{i}", token),
                    )
                    return "OK"
                except psycopg.errors.Error as e:
                    return str(e).split("\n")[0].strip()
        finally:
            await conn.close()

    async def race():
        return await asyncio.wait_for(
            asyncio.gather(*(buy(i) for i in range(n))), timeout=60
        )

    results = asyncio.run(race())
    ok = [r for r in results if r == "OK"]
    assert len(ok) == 1, f"SOBREVENTA: {len(ok)} boletas vendidas para 1 lugar ({results})"
