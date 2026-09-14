"""Prueba de carrera: N escaneos concurrentes de la MISMA boleta.

Invariante: exactamente 1 'GRANTED' y el resto 'ALREADY_REDEEMED'. Es la
prueba real del compare-and-swap de redeem_ticket.

Uso:
    .venv/bin/python backend/tests/test_race_redeem.py
Requiere psycopg + async (psycopg[pool]).
"""
import asyncio
import secrets

import psycopg


async def main() -> None:
    dsn = "postgresql://postgres:test@127.0.0.1:5433/tickets"
    conn = await psycopg.AsyncConnection.connect(dsn, autocommit=True)
    async with conn.cursor() as cur:
        # escenario idempotente: 1 evento, 1 tipo, 1 boleta emitida
        await cur.execute("DELETE FROM tickets WHERE customer_name='Carrera'")
        await cur.execute("INSERT INTO users (email,password_hash,full_name) VALUES ('race@test.co','x','Race') ON CONFLICT (email) DO NOTHING")
        await cur.execute("INSERT INTO venues (name,slug) VALUES ('Race Venue','race-venue') ON CONFLICT (slug) DO NOTHING")
        await cur.execute(
            "INSERT INTO events (venue_id,name,starts_at,capacity,status) "
            "SELECT id,'Race Night',now()+'3d',100,'published' FROM venues WHERE slug='race-venue' "
            "ON CONFLICT DO NOTHING"
        )
        await cur.execute(
            "INSERT INTO ticket_types (event_id,name,price_cents,quantity,is_courtesy) "
            "SELECT id,'General',10000,100,FALSE FROM events WHERE name='Race Night' "
            "ON CONFLICT (event_id,name) DO NOTHING"
        )
        await cur.execute("SELECT e.id, tt.id, u.id FROM events e, ticket_types tt, users u WHERE e.name='Race Night' AND tt.name='General' AND u.email='race@test.co'")
        row = await cur.fetchone()
        ev_id, tt_id, user_id = row[0], row[1], row[2]

        token = secrets.token_urlsafe(24)
        await cur.execute(
            "SELECT emit_ticket(%s, %s, NULL, %s, 'Carrera', %s, NULL, NULL)",
            (ev_id, tt_id, user_id, token),
        )
        print(f"boleta emitida (event={ev_id} user={user_id})")

    # --- N escaneos concurrentes ----------------------------------------
    N = 12

    async def scan(i: int) -> tuple[int, str]:
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as c:
            async with c.cursor() as cur:
                await cur.execute("SELECT redeem_ticket(%s, %s, %s)", (ev_id, token, user_id))
                row = await cur.fetchone()
                return i, row[0]

    results = await asyncio.gather(*(scan(i) for i in range(N)))

    granted = [i for i, r in results if r == "GRANTED"]
    others = [r for i, r in results if r != "GRANTED"]
    print(f"  GRANTED: {len(granted)} ({granted})")
    print(f"  otros  : {len(others)} -> {set(others)}")

    assert len(granted) == 1, f"FALLO: esperabamos 1 GRANTED, hubo {len(granted)}"
    assert all(r == "ALREADY_REDEEMED" for r in others), f"FALLO: outcomes inesperados: {others}"
    print("==> PRUEBA DE CARRERA PASÓ (1 GRANTED, el resto ALREADY_REDEEMED)")


if __name__ == "__main__":
    asyncio.run(main())