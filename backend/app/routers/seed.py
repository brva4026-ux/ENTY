"""Seed de datos demo (solo para desarrollo local).

Crea una venue de ejemplo con sus usuarios y roles de forma idempotente para
poder probar la API sin procesos de registro. Llama de forma manual via:
    POST /seed  (solo si `IS_DEMO=true`)
"""
import psycopg
from fastapi import APIRouter, Depends, HTTPException

from app.core.config import get_settings
from app.core.db import get_db
from app.core.security import hash_password

router = APIRouter(prefix="/seed", tags=["dev"])

_DEFAULT_PASSWORD = "demo1234"


async def seed_demo_data(db: psycopg.AsyncConnection) -> dict:
    async with db.cursor() as cur:
        # --- venue -----------------------------------------------------
        await cur.execute(
            "INSERT INTO venues (name, slug) VALUES ('Bar Esquina', 'bar-esquina') "
            "ON CONFLICT (slug) DO NOTHING RETURNING id"
        )
        row = await cur.fetchone()
        if row:
            venue_id = row["id"]
        else:
            await cur.execute("SELECT id FROM venues WHERE slug='bar-esquina'")
            venue_id = (await cur.fetchone())["id"]

        # --- users ----------------------------------------------------
        demo_users = [
            ("admin@bar.test", "Admin Bar Esquina", "admin"),
            ("promo1@bar.test", "Promo Uno", "promotor"),
            ("promo2@bar.test", "Promo Dos", "promotor"),
            ("puerta@bar.test", "Bouncer Puerta", "bouncer"),
        ]
        user_ids: dict[str, int] = {}
        for email, name, _role in demo_users:
            await cur.execute(
                "INSERT INTO users (email, phone, password_hash, full_name) "
                "VALUES (%s, NULL, %s, %s) ON CONFLICT (email) DO NOTHING RETURNING id",
                (email, hash_password(_DEFAULT_PASSWORD), name),
            )
            row = await cur.fetchone()
            if row:
                user_ids[email] = row["id"]
            else:
                await cur.execute("SELECT id FROM users WHERE email=%s", (email,))
                user_ids[email] = (await cur.fetchone())["id"]

        # --- roles ----------------------------------------------------
        for email, _name, role in demo_users:
            await cur.execute(
                "INSERT INTO venue_user_roles (venue_id, user_id, role) "
                "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                (venue_id, user_ids[email], role),
            )

        # --- evento de ejemplo -------------------------------------------------
        admin_id = user_ids["admin@bar.test"]
        promo1_id = user_ids["promo1@bar.test"]
        await cur.execute(
            """
            INSERT INTO events (venue_id, name, description, starts_at, capacity, status)
            VALUES (%s, 'Noche Electrónica', 'DJ set + open bar cortesías',
                    now() + interval '7 days', 100, 'published')
            ON CONFLICT DO NOTHING RETURNING id
            """,
            (venue_id,),
        )
        row = await cur.fetchone()
        if row:
            event_id = row["id"]
        else:
            await cur.execute(
                "SELECT id FROM events WHERE venue_id=%s AND name='Noche Electrónica'",
                (venue_id,),
            )
            event_id = (await cur.fetchone())["id"]

        # --- tipos de boleta -------------------------------------------------
        await cur.execute(
            "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) "
            "VALUES (%s, 'General', 30000, 80, FALSE) ON CONFLICT (event_id, name) DO NOTHING",
            (event_id,),
        )
        await cur.execute(
            "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) "
            "VALUES (%s, 'Cortesia', 0, 20, TRUE) ON CONFLICT (event_id, name) DO NOTHING",
            (event_id,),
        )

        # --- cupos de promotor ------------------------------------------------
        await cur.execute(
            "SELECT id FROM ticket_types WHERE event_id=%s AND name='Cortesia'", (event_id,)
        )
        cortesia_id = (await cur.fetchone())["id"]

        # promo1 tiene 5 cortesias, promo2 tiene 3
        await cur.execute(
            """
            INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity)
            VALUES (%s, %s, %s, 5) ON CONFLICT DO NOTHING
            """,
            (event_id, cortesia_id, promo1_id),
        )
        promo2_id = user_ids["promo2@bar.test"]
        await cur.execute(
            """
            INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity)
            VALUES (%s, %s, %s, 3) ON CONFLICT DO NOTHING
            """,
            (event_id, cortesia_id, promo2_id),
        )

        await db.commit()

        return {
            "venue_id": venue_id,
            "event_id": event_id,
            "users": {email: user_ids[email] for email, *_ in demo_users},
            "password": _DEFAULT_PASSWORD,
        }


@router.post("")
async def seed(settings=Depends(get_settings), db=Depends(get_db)):
    """Lanza el seed demo. Solo disponible cuando IS_DEMO=true."""
    if not getattr(settings, "IS_DEMO", False) and getattr(settings, "ENV", "local") != "local":
        raise HTTPException(403, "Seed solo disponible en local")
    return await seed_demo_data(db)