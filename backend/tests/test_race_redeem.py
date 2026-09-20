"""Prueba de carrera: N escaneos concurrentes de la MISMA boleta (CI).

Historia: este test vivio como script suelto con DSN hardcodeado y quedo
excluido del pytest (`--ignore=tests/test_race_redeem.py` en el CI). Pero es
LA prueba del compare-and-swap de `redeem_ticket` - el mecanismo anti-
sobreventa - asi que ahora corre en el pipeline contra el Postgres efimero
del job, con el mismo esquema y migraciones que los demas tests.

Invariante: exactamente 1 'GRANTED' y el resto 'ALREADY_REDEEMED'. Dos
puertas (o doce) escaneando el mismo QR a la vez: una sola gana.
"""
import asyncio
import os
import secrets

import psycopg
from psycopg.rows import dict_row

# DSN del CI (el mismo que usa el conftest para la session-scoped db)
DSN = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
)

N_SCANS = 12


def test_race_redeem_single_granted(api):
    """12 conexiones concurrentes canjean el mismo token: 1 GRANTED."""
    scen = api.scenario()
    admin_id = api.world["admin"]["id"]

    # Boleta activa YA (la ventana de activacion de la mig 013 exige que
    # starts_at - qr_unlock ya paso): abrimos el evento 2 horas atras.
    with psycopg.connect(DSN, autocommit=True, row_factory=dict_row) as setup:
        with setup.cursor() as cur:
            cur.execute(
                "UPDATE events SET starts_at = now() - interval '2 hours' WHERE id = %s",
                (scen["event"],),
            )
            token = secrets.token_urlsafe(24)
            cur.execute(
                "SELECT emit_ticket(%s, %s, NULL, %s, 'Carrera', %s, NULL, NULL)",
                (scen["event"], scen["type"], admin_id, token),
            )
            ticket_id = cur.fetchone()["emit_ticket"]
            assert ticket_id is not None

    # --- N escaneos concurrentes, cada uno en SU propia conexion ---------
    # (la carrera real es entre transacciones distintas, no entre tareas
    # que comparten conexion: ahi el servidor serializaria por si mismo).
    async def run_race():
        async def scan(i: int) -> tuple[int, str]:
            conn = await psycopg.AsyncConnection.connect(DSN, autocommit=True)
            try:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "SELECT redeem_ticket(%s, %s, %s)",
                        (scen["event"], token, admin_id),
                    )
                    row = await cur.fetchone()
                    return i, (row[0] if not isinstance(row, dict) else list(row.values())[0])
            finally:
                await conn.close()

        return await asyncio.gather(*(scan(i) for i in range(N_SCANS)))

    results = asyncio.run(run_race())

    granted = [i for i, r in results if r == "GRANTED"]
    others = [r for i, r in results if r != "GRANTED"]

    assert len(granted) == 1, (
        f"ANTI-SOBREVENTA ROTA: esperabamos 1 GRANTED, hubo {len(granted)} "
        f"({results})"
    )
    assert all(r == "ALREADY_REDEEMED" for r in others), (
        f"Resultados inesperados en la carrera: {others}"
    )
