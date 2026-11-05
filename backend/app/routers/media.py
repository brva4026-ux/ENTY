"""Almacenamiento simple de imagenes subidas (flyers, logo) en la propia DB.

Vercel serverless no tiene disco persistente y contratar S3/R2 para un flyer
es sobredimensionado a este tamano: los bytes viven en `media` (mig 018) y se
sirven por GET /media/{id} con cache inmutable — el contenido de un id nunca
cambia (subir de nuevo crea OTRO id).

Subida: el navegador reduce la imagen (canvas) y manda un data-URL JSON; el
backend decodifica, valida mime y tamano, y guarda. Sin multipart ni
dependencias nuevas en la funcion serverless (el incidente
FUNCTION_INVOCATION_FAILED por import roto manda).

GET es publico a proposito: un flyer es publicidad — el invitado que abre su
boleta pinta la imagen sin sesion.
"""
import base64
import binascii
import re
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user

router = APIRouter(tags=["media"])

MAX_BYTES = 600_000  # coincide con el CHECK de la mig 018
# El canvas del navegador produce jpeg (principal), png o webp: los tres son
# seguros de pintar en <img> y los tres los valida el CHECK de la DB.
_DATA_URL = re.compile(r"^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$")


class MediaUpload(BaseModel):
    """data-URL de la imagen ya reducida en el navegador."""

    data_url: str = Field(max_length=1_200_000)


def _decode_data_url(data_url: str) -> tuple[str, bytes]:
    """Valida el data-URL de una imagen y devuelve (mime, bytes).

    Compartido por las subidas de negocio (flyer, logo) y por el avatar de la
    persona: que es una imagen aceptable no puede depender del camino por el
    que llega.
    """
    m = _DATA_URL.match(data_url.strip())
    if not m:
        raise HTTPException(
            422,
            "La imagen debe ser un data-URL de JPEG, PNG o WebP "
            "(data:image/jpeg;base64,…).",
        )
    mime, payload = m.group(1), m.group(2)
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(422, "El contenido base64 de la imagen no es válido.")
    if not raw:
        raise HTTPException(422, "La imagen llega vacía.")
    if len(raw) > MAX_BYTES:
        # 413 literal (no status.HTTP_413_*): el nombre nuevo de Starlette no
        # existe en las versiones que permite fastapi>=0.111, y el viejo
        # emite un DeprecationWarning. El código numérico es estable en todas.
        raise HTTPException(
            413,
            "La imagen supera los 600 KB después de decodificar.",
        )
    return mime, raw


async def store_image(
    db: psycopg.AsyncConnection,
    *,
    data_url: str,
    venue_id: int | None,
    user_id: int,
) -> dict:
    """Inserta una imagen en `media` y devuelve {id, mime, size_bytes}.

    No hace commit: el llamador cierra la transaccion. El avatar lo necesita
    asi para escribir `users.avatar_url` en el mismo acto que la subida, y para
    borrar la imagen anterior si todo va bien.

    `venue_id` en None = imagen de una persona, no de un negocio (mig 038).
    """
    mime, raw = _decode_data_url(data_url)
    async with db.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO media (venue_id, mime, bytes, size_bytes, created_by)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (venue_id, mime, raw, len(raw), user_id),
        )
        row = await cur.fetchone()
    return {"id": row["id"], "mime": mime, "size_bytes": len(raw)}


@router.post("/venues/{venue_id}/media", status_code=status.HTTP_201_CREATED)
async def upload_media(
    venue_id: int,
    body: MediaUpload,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Guarda una imagen y devuelve la URL relativa para usar en flyer/logo."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    media = await store_image(
        db, data_url=body.data_url, venue_id=venue_id, user_id=user["id"]
    )
    await db.commit()
    return {
        "url": f"/media/{media['id']}",
        "size_bytes": media["size_bytes"],
        "mime": media["mime"],
    }


@router.get("/media/{media_id}")
async def get_media(
    media_id: int,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Sirve los bytes de una imagen subida. Publico: el flyer es publicidad.

    Cache inmutable: el contenido de un id NUNCA cambia (una nueva version es
    otro id), asi que el navegador puede agarrarlo para siempre.
    """
    async with db.cursor() as cur:
        await cur.execute("SELECT mime, bytes FROM media WHERE id = %s", (media_id,))
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Imagen no encontrada")
    return Response(
        content=row["bytes"],
        media_type=row["mime"],
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Robots-Tag": "noindex",
        },
    )

