"""Seed de datos demo (solo para desarrollo local).

Crea una venue de ejemplo con sus usuarios y roles de forma idempotente para
poder probar la API sin procesos de registro. Llama de forma manual via:
    POST /seed  (solo si `IS_DEMO=true`)
"""
import secrets

import psycopg
from fastapi import APIRouter, Depends, HTTPException

from app.core.config import get_settings
from app.core.db import get_db
from app.core.security import hash_password

router = APIRouter(prefix="/seed", tags=["dev"])

_DEFAULT_PASSWORD = "demo1234"


async def _ensure_fan_ticket(
    cur: psycopg.AsyncCursor,
    event_id: int,
    ticket_type_id: int,
    allocation_id: int,
    seller_id: int,
    email: str,
    phone: str,
) -> None:
    """Emite una cortesia para el fan demo una sola vez (idempotente).

    El token crudo se genera y se descarta: la DB solo guarda su hash y el fan
    pide uno nuevo desde /boletas ("Ver mi QR").
    """
    await cur.execute(
        "SELECT id FROM tickets WHERE event_id=%s AND customer_email=%s",
        (event_id, email),
    )
    if await cur.fetchone():
        return
    await cur.execute(
        "SELECT emit_ticket(%s, %s, %s, %s, %s, %s, %s, %s)",
        (
            event_id,
            ticket_type_id,
            allocation_id,
            seller_id,
            "Fan Demo",
            secrets.token_urlsafe(24),
            phone,
            email,
        ),
    )


async def _ensure_event(
    cur: psycopg.AsyncCursor,
    venue_id: int,
    name: str,
    description: str,
    interval_sql: str,
    capacity: int,
) -> int:
    """Devuelve el id de un evento del seed, creandolo o re-fechandolo.

    `events` no tiene UNIQUE(venue_id, name), asi que `ON CONFLICT DO NOTHING`
    no evita duplicados: hay que buscar antes de insertar. `interval_sql` es un
    literal constante del seed (no entrada del usuario).

    El evento demo se RE-FECHA en cada corrida. Antes solo se insertaba la
    primera vez, asi que a los pocos dias su `starts_at` quedaba en el pasado y
    la vitrina publica (`/public/events`, que filtra `starts_at >= now()`)
    mostraba la cartelera VACIA. Volver a sembrar no lo arreglaba: el seed veia
    el evento existente y salia sin tocarlo.

    La busqueda se acota a `published`/`live`: un demo terminado o cancelado no
    se puede republicar (el trigger `events_check_transition` lo bloquea), asi
    que si solo queda historia se inserta uno nuevo en vez de revivirla.
    """
    starts_sql = f"now() + interval '{interval_sql}'"
    await cur.execute(
        "SELECT id FROM events WHERE venue_id=%s AND name=%s "
        "AND status IN ('published', 'live') ORDER BY id LIMIT 1",
        (venue_id, name),
    )
    row = await cur.fetchone()
    if row:
        await cur.execute(
            f"UPDATE events SET starts_at = {starts_sql} WHERE id = %s",
            (row["id"],),
        )
        return row["id"]
    await cur.execute(
        f"""
        INSERT INTO events (venue_id, name, description, starts_at, capacity, status)
        VALUES (%s, %s, %s, {starts_sql}, %s, 'published')
        RETURNING id
        """,
        (venue_id, name, description, capacity),
    )
    return (await cur.fetchone())["id"]


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
        # El cuarto campo es el nombre de usuario para entrar (mig 035): la
        # gente de puerta entra desde el celular y "puerta" es mucho mas rapido
        # de teclear que "puerta@bar.test". Se siembra para poder probar el
        # flujo de "usuario o correo" sin dar de alta una cuenta a mano.
        demo_users = [
            ("admin@bar.test", "Admin Bar Esquina", "admin", "admin"),
            ("promo1@bar.test", "Promo Uno", "promotor", "promo1"),
            ("promo2@bar.test", "Promo Dos", "promotor", "promo2"),
            ("puerta@bar.test", "Bouncer Puerta", "bouncer", "puerta"),
        ]
        user_ids: dict[str, int] = {}
        for email, name, _role, username in demo_users:
            await cur.execute(
                "INSERT INTO users (email, phone, password_hash, full_name, username) "
                "VALUES (%s, NULL, %s, %s, %s) ON CONFLICT (email) DO NOTHING RETURNING id",
                (email, hash_password(_DEFAULT_PASSWORD), name, username),
            )
            row = await cur.fetchone()
            if row:
                user_ids[email] = row["id"]
            else:
                # Ya existia: se le completa el username si todavia no tiene uno.
                # ON CONFLICT DO NOTHING no actualiza, y una base creada antes de
                # la 035 se quedaria sin el. Solo si esta libre, para no pisar a
                # otro usuario que ya lo haya reclamado.
                await cur.execute(
                    "UPDATE users SET username=%s WHERE email=%s AND username IS NULL "
                    "AND NOT EXISTS (SELECT 1 FROM users o WHERE lower(o.username)=lower(%s))",
                    (username, email, username),
                )
                await cur.execute("SELECT id FROM users WHERE email=%s", (email,))
                user_ids[email] = (await cur.fetchone())["id"]

        # --- roles ----------------------------------------------------
        for email, _name, role, _username in demo_users:
            await cur.execute(
                "INSERT INTO venue_user_roles (venue_id, user_id, role) "
                "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                (venue_id, user_ids[email], role),
            )

        # --- evento de ejemplo -------------------------------------------------
        admin_id = user_ids["admin@bar.test"]
        promo1_id = user_ids["promo1@bar.test"]
        event_id = await _ensure_event(
            cur, venue_id, "Noche Electrónica",
            "DJ set + open bar cortesías", "7 days", 100,
        )

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

        # --- boletas de un fan demo ------------------------------------------
        # El fan no tiene cuenta: para probar /boletas hace falta una boleta
        # emitida a un contacto conocido. Son cortesias emitidas por promo1
        # (que tiene la asignacion de cortesia). Dos eventos: uno lejano, para
        # ver la boleta con el QR aun inactivo, y uno inminente, para ver el QR
        # ya activo y escaneable.
        fan_email = "fan@bar.test"
        fan_phone = "3100000001"

        await cur.execute(
            "SELECT id FROM promoter_allocations WHERE event_id=%s AND promoter_id=%s",
            (event_id, promo1_id),
        )
        alloc_id = (await cur.fetchone())["id"]

        soon_event_id = await _ensure_event(
            cur, venue_id, "Prueba de QR",
            "Evento que empieza en 20 min para probar el QR activo", "20 minutes", 50,
        )

        await cur.execute(
            "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) "
            "VALUES (%s, 'Cortesia', 0, 20, TRUE) ON CONFLICT (event_id, name) DO NOTHING",
            (soon_event_id,),
        )
        await cur.execute(
            "SELECT id FROM ticket_types WHERE event_id=%s AND name='Cortesia'", (soon_event_id,)
        )
        soon_type_id = (await cur.fetchone())["id"]
        await cur.execute(
            """
            INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity)
            VALUES (%s, %s, %s, 5) ON CONFLICT DO NOTHING
            """,
            (soon_event_id, soon_type_id, promo1_id),
        )
        await cur.execute(
            "SELECT id FROM promoter_allocations WHERE event_id=%s AND promoter_id=%s",
            (soon_event_id, promo1_id),
        )
        soon_alloc_id = (await cur.fetchone())["id"]

        await _ensure_fan_ticket(
            cur, event_id, cortesia_id, alloc_id, promo1_id,
            fan_email, fan_phone,
        )
        await _ensure_fan_ticket(
            cur, soon_event_id, soon_type_id, soon_alloc_id, promo1_id,
            fan_email, fan_phone,
        )

        # --- roster de la noche ----------------------------------------------
        # El promotor ve su tarjeta "Mis noches" (con el medidor de cupo) solo
        # en los eventos donde figura en event_staff; sin este roster la
        # tarjeta no aparece en la demo. promo1/promo2 trabajan ambas noches y
        # puerta queda asignada como bouncer.
        for ev_id in (event_id, soon_event_id):
            for uid, role in (
                (promo1_id, "promotor"),
                (promo2_id, "promotor"),
                (user_ids["puerta@bar.test"], "bouncer"),
            ):
                await cur.execute(
                    "INSERT INTO event_staff (event_id, user_id, role, assigned_by) "
                    "VALUES (%s, %s, %s, %s) ON CONFLICT (event_id, user_id) DO NOTHING",
                    (ev_id, uid, role, admin_id),
                )

        await db.commit()

        return {
            "venue_id": venue_id,
            "event_id": event_id,
            "users": {email: user_ids[email] for email, *_ in demo_users},
            "password": _DEFAULT_PASSWORD,
            # Contacto del fan para probar "Mis boletas" (/boletas). No tiene
            # cuenta: basta con escribir este correo o telefono en la pantalla.
            "fan": {"email": fan_email, "phone": fan_phone},
        }


@router.post("")
async def seed(settings=Depends(get_settings), db=Depends(get_db)):
    """Lanza el seed demo. Requiere IS_DEMO=true explicito en el entorno."""
    if not settings.is_demo:
        raise HTTPException(
            403,
            "Seed deshabilitado. Define IS_DEMO=true solo en entornos de prueba.",
        )
    return await seed_demo_data(db)