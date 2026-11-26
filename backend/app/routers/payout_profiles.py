"""Verificación del organizador antes de habilitar cobros en línea.

El evento puede nacer en borrador sin fricción. Lo que se revisa es la
capacidad de vender: quién responde legalmente y a dónde llega el dinero.
"""
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import PayoutProfileIn, PayoutReviewIn

router = APIRouter(tags=["payout-profiles"])

_REQUIRED = {
    "legal_name": "Razón social o nombre del responsable",
    "tax_id": "Documento fiscal",
    "contact_name": "Persona de contacto",
    "contact_phone": "Teléfono de contacto",
    "bank_name": "Banco o billetera",
    "bank_account_type": "Tipo de cuenta",
    "bank_account_last4": "Últimos 4 dígitos de la cuenta",
}


def _missing(row: dict) -> list[str]:
    return [label for key, label in _REQUIRED.items() if not row.get(key)]


def _payload(row: dict) -> dict:
    missing = _missing(row)
    return {
        **row,
        "missing_items": missing,
        "can_sell_online": row.get("status") == "approved" and not missing,
    }


async def _venue(cur, venue_id: int) -> dict:
    await cur.execute(
        "SELECT id, name, legal_name, tax_id FROM venues WHERE id=%s",
        (venue_id,),
    )
    venue = await cur.fetchone()
    if not venue:
        raise HTTPException(404, "Negocio no encontrado")
    return venue


async def _profile(cur, venue_id: int) -> dict | None:
    await cur.execute(
        "SELECT * FROM venue_payout_profiles WHERE venue_id=%s", (venue_id,)
    )
    return await cur.fetchone()


@router.get("/venues/{venue_id}/payout-profile")
async def get_payout_profile(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        venue = await _venue(cur, venue_id)
        row = await _profile(cur, venue_id)
    if not row:
        row = {
            "venue_id": venue_id,
            "status": "not_started",
            "legal_name": venue.get("legal_name"),
            "tax_id": venue.get("tax_id"),
            "contact_name": None,
            "contact_phone": None,
            "contact_email": None,
            "bank_name": None,
            "bank_account_type": None,
            "bank_account_last4": None,
            "payout_provider": None,
            "payout_account_ref": None,
            "review_note": None,
            "submitted_at": None,
            "reviewed_at": None,
        }
    return _payload(row)


@router.put("/venues/{venue_id}/payout-profile")
async def save_payout_profile(
    venue_id: int,
    body: PayoutProfileIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _venue(cur, venue_id)
        current = await _profile(cur, venue_id)
        values = body.model_dump()
        next_status = current["status"] if current else "not_started"

        # Cambiar la cuenta después de aprobada exige una revisión nueva: si
        # no, el sello de aprobación terminaría cubriendo otra cuenta.
        if current and current["status"] == "approved":
            destination = ("bank_name", "bank_account_type", "bank_account_last4",
                           "payout_provider", "payout_account_ref")
            if any((current.get(k) or "") != (values.get(k) or "") for k in destination):
                next_status = "pending"
        await cur.execute(
            """
            INSERT INTO venue_payout_profiles
                (venue_id, status, legal_name, tax_id, contact_name,
                 contact_phone, contact_email, bank_name, bank_account_type,
                 bank_account_last4, payout_provider, payout_account_ref,
                 missing_items)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (venue_id) DO UPDATE
               SET status=EXCLUDED.status,
                   legal_name=EXCLUDED.legal_name,
                   tax_id=EXCLUDED.tax_id,
                   contact_name=EXCLUDED.contact_name,
                   contact_phone=EXCLUDED.contact_phone,
                   contact_email=EXCLUDED.contact_email,
                   bank_name=EXCLUDED.bank_name,
                   bank_account_type=EXCLUDED.bank_account_type,
                   bank_account_last4=EXCLUDED.bank_account_last4,
                   payout_provider=EXCLUDED.payout_provider,
                   payout_account_ref=EXCLUDED.payout_account_ref,
                   missing_items=EXCLUDED.missing_items,
                   reviewed_at=CASE WHEN %s='pending' THEN NULL ELSE venue_payout_profiles.reviewed_at END,
                   reviewed_by_user_id=CASE WHEN %s='pending' THEN NULL ELSE venue_payout_profiles.reviewed_by_user_id END,
                   review_note=CASE WHEN %s='pending' THEN NULL ELSE venue_payout_profiles.review_note END,
                   updated_at=now()
            """,
            (
                venue_id, next_status, values["legal_name"], values["tax_id"],
                values["contact_name"], values["contact_phone"],
                values["contact_email"], values["bank_name"],
                values["bank_account_type"], values["bank_account_last4"],
                values["payout_provider"], values["payout_account_ref"],
                _missing(values), next_status, next_status, next_status,
            ),
        )
        row = await _profile(cur, venue_id)
        await db.commit()
    return _payload(row)


@router.post("/venues/{venue_id}/payout-profile/submit")
async def submit_payout_profile(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _venue(cur, venue_id)
        row = await _profile(cur, venue_id)
        if not row:
            raise HTTPException(422, "Guarda los datos de cobro antes de enviarlos")
        missing = _missing(row)
        if missing:
            raise HTTPException(422, "Falta completar: " + ", ".join(missing))
        await cur.execute(
            """
            UPDATE venue_payout_profiles
               SET status='pending', missing_items='{}'::text[],
                   submitted_at=now(), reviewed_at=NULL,
                   reviewed_by_user_id=NULL, review_note=NULL,
                   updated_at=now()
             WHERE venue_id=%s
            """,
            (venue_id,),
        )
        row = await _profile(cur, venue_id)
        await db.commit()
    return _payload(row)


@router.post("/venues/{venue_id}/payout-profile/review")
async def review_payout_profile(
    venue_id: int,
    body: PayoutReviewIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin")
    if body.status == "rejected" and not (body.note or "").strip():
        raise HTTPException(422, "Explica qué falta para rechazar la revisión")
    async with db.cursor() as cur:
        await _venue(cur, venue_id)
        row = await _profile(cur, venue_id)
        if not row:
            raise HTTPException(404, "El negocio no ha enviado datos de cobro")
        if row["status"] != "pending":
            raise HTTPException(409, "Solo se revisan solicitudes pendientes")
        await cur.execute(
            """
            UPDATE venue_payout_profiles
               SET status=%s, review_note=%s, reviewed_at=now(),
                   reviewed_by_user_id=%s, updated_at=now()
             WHERE venue_id=%s
            """,
            (body.status, (body.note or "").strip() or None, user["id"], venue_id),
        )
        if body.status == "approved":
            await cur.execute(
                """
                UPDATE venues
                   SET legal_name=COALESCE(%s, legal_name),
                       tax_id=COALESCE(%s, tax_id)
                 WHERE id=%s
                """,
                (row.get("legal_name"), row.get("tax_id"), venue_id),
            )
        row = await _profile(cur, venue_id)
        await db.commit()
    return _payload(row)
