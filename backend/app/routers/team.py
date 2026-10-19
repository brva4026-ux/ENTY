"""Módulo Equipo: métricas de productividad real por persona.

Datos que la UI agrupa y presenta. Cada campo existe para responder una
pregunta operativa del admin:

- qué hace cada quien (rol),
- si está activo (cuenta) y si entra a trabajar (last_login_at),
- cuánto ha vendido (cupo usado, boletas emitidas, recaudo) — promotores,
- cuánto ha trabajado en puerta (escaneos, aciertos, intentos bloqueados)
  — porteros,
- desde cuándo forma parte del equipo (created_at del rol).

Sin IA ni scorecards inventadas: solo agregados de tickets y redemptions.
"""
from datetime import datetime, timedelta, timezone
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import TeamStatsOut

router = APIRouter(prefix="/venues/{venue_id}", tags=["equipo"])


@router.get("/users/stats", response_model=TeamStatsOut)
async def team_stats(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    days: int = 90,
):
    """Resumen ejecutivo del equipo de la venue.

    `days` acota la ventana operativa (default 90). Ventana corta => snapshot
    del momento; larga => histórico del personal.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    if venue_id not in user["venue_ids"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No perteneces a esta venue")
    if not 1 <= days <= 365:
        raise HTTPException(422, "days debe estar entre 1 y 365")

    window_start = datetime.now(timezone.utc) - timedelta(days=days)

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at,
                   array_agg(DISTINCT r.role)::text[] AS roles,
                   min(r.created_at) AS member_since
            FROM venue_user_roles r
            JOIN users u ON u.id = r.user_id
            WHERE r.venue_id = %s
            GROUP BY u.id, u.email, u.full_name, u.is_active, u.last_login_at
            ORDER BY u.is_active DESC, u.full_name
            """,
            (venue_id,),
        )
        rows = await cur.fetchall()

        # -- Ventas de promotores (boletas emitidas contra su cupo) ---------
        # Un usuario puede tener varios roles: las métricas son por usuario,
        # la UI decide cómo presentarlas según su rol principal.
        await cur.execute(
            """
            SELECT t.sold_by_user_id AS user_id,
                   count(*) FILTER (WHERE t.status IN ('issued','redeemed'))::int AS issued,
                   count(*) FILTER (WHERE t.status = 'redeemed')::int             AS redeemed,
                   coalesce(sum(t.price_cents_snapshot)
                            FILTER (WHERE t.status IN ('issued','redeemed')), 0)::bigint AS revenue_cents
            FROM tickets t
            JOIN events e ON e.id = t.event_id
            WHERE e.venue_id = %s
              AND t.sold_by_user_id IS NOT NULL
              AND t.issued_at >= now() - make_interval(days => %s)
            GROUP BY t.sold_by_user_id
            """,
            (venue_id, days),
        )
        sales = {r["user_id"]: r for r in await cur.fetchall()}

        # -- Cupo activo por promotor (lo que la UI dibuja como barra) ------
        # Solo eventos no terminados: el cupo de un evento que ya pasó ya no
        # es "cupo vigente", es histórico (y eso lo cubre `issued`).
        await cur.execute(
            """
            SELECT a.promoter_id AS user_id,
                   sum(a.capacity)::int AS capacity,
                   count(*)::int        AS allocations
            FROM promoter_allocations a
            JOIN events e ON e.id = a.event_id
            WHERE e.venue_id = %s
              AND e.status IN ('draft','published','live')
            GROUP BY a.promoter_id
            """,
            (venue_id,),
        )
        quotas = {r["user_id"]: r for r in await cur.fetchall()}

        # -- Trabajo en puerta por portero ----------------------------------
        await cur.execute(
            """
            SELECT r.scanned_by_user_id AS user_id,
                   count(*) FILTER (WHERE r.outcome IN ('granted','granted_forced'))::int AS granted,
                   count(*) FILTER (WHERE r.outcome NOT IN ('granted','granted_forced'))::int AS rejected,
                   count(*)::int                                       AS total
            FROM redemptions r
            WHERE r.event_id IN (SELECT id FROM events WHERE venue_id = %s)
              AND r.scanned_at >= now() - make_interval(days => %s)
            GROUP BY r.scanned_by_user_id
            """,
            (venue_id, days),
        )
        scans = {r["user_id"]: r for r in await cur.fetchall()}

    members = []
    for r in rows:
        uid = r["id"]
        s = sales.get(uid, {})
        q = quotas.get(uid, {})
        sc = scans.get(uid, {})
        members.append(
            {
                "id": uid,
                "email": r["email"],
                "full_name": r["full_name"],
                "roles": list(r["roles"] or []),
                "is_active": r["is_active"],
                "last_login_at": r["last_login_at"],
                "member_since": r["member_since"],
                "quota": {
                    "capacity": q.get("capacity", 0),
                    "issued": s.get("issued", 0),
                    "redeemed": s.get("redeemed", 0),
                    "revenue_cents": int(s.get("revenue_cents", 0)),
                    "allocations": q.get("allocations", 0),
                },
                "door": {
                    "granted": sc.get("granted", 0),
                    "rejected": sc.get("rejected", 0),
                    "total": sc.get("total", 0),
                },
            }
        )

    # Personal operativo activo que SÍ entró a trabajar dentro de la ventana:
    # el indicador de "quién está al día" (admins excluidos: ellos gestionan,
    # no producen ventas ni escaneos).
    staff = [m for m in members if m["is_active"] and "admin" not in m["roles"] and "super_admin" not in m["roles"]]
    active_in_window = len(
        [m for m in staff if m["last_login_at"] and m["last_login_at"] >= window_start]
    )

    return {
        "total_members": len(members),
        "active_members": len([m for m in members if m["is_active"]]),
        "promoters_active": len([m for m in members if m["is_active"] and "promotor" in m["roles"]]),
        "bouncers_active": len([m for m in members if m["is_active"] and "bouncer" in m["roles"]]),
        "active_in_window": active_in_window,
        "days_window": days,
        "members": members,
        "by_role": {
            "promotor": [m["id"] for m in members if "promotor" in m["roles"]],
            "bouncer": [m["id"] for m in members if "bouncer" in m["roles"]],
            "admin": [
                m["id"] for m in members if "admin" in m["roles"] or "super_admin" in m["roles"]
            ],
        },
    }
