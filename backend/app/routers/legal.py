"""Documentos legales y aceptaciones versionadas (mig 026).

Publicar los Terminos y Condiciones no sirve de nada si no se puede probar
QUIEN acepto, CUANDO y QUE VERSION. Este router es la mitad de esa prueba (la
otra mitad es la tabla `legal_acceptances`, con FK a la version aceptada: no se
puede registrar la aceptacion de un texto que no existe).

El TEXTO de los documentos vive en backend/app/assets/legal/*.md — una sola
copia, versionada en git. Aqui vive el catalogo (que documento rige hoy, con que
version) y el registro de las aceptaciones. Separarlo evita el modo de falla mas
caro de los terminos y condiciones: que la pagina publique una version y la base
tenga otra.

Endpoints publicos (el invitado no tiene cuenta):
  GET  /legal/documents        catalogo vigente + huella de versiones
  GET  /legal/documents/{slug} el texto en markdown
  POST /legal/acceptances      registra una aceptacion

Endpoint autenticado:
  GET  /legal/status           que acepte y que me falta aceptar
"""
import hashlib
import re
from pathlib import Path
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import PlainTextResponse

from app.core.db import get_db
from app.core.limiter import limiter
from app.deps import get_current_user
from app.schemas import (
    LegalAcceptanceCreate,
    LegalAcceptanceOut,
    LegalDocumentOut,
    LegalDocumentsOut,
    LegalStatusOut,
)

router = APIRouter(prefix="/legal", tags=["legal"])

_LEGAL_DIR = Path(__file__).resolve().parents[1] / "assets" / "legal"
# El slug se valida ANTES de tocar el disco (el nombre del archivo sale de la
# DB, no del request, pero la lista blanca cierra el path traversal de raiz).
_SLUG_RE = re.compile(r"^[a-z0-9-]{3,60}$")

# Version vigente de cada documento: la mas reciente por slug. Se compara por
# created_at y no por el texto de la version ('10.0' < '9.0' alfabeticamente).
_CURRENT_SQL = """
    SELECT slug, version, title, url, requires_acceptance, effective_date
      FROM legal_documents d
     WHERE d.created_at = (
               SELECT max(d2.created_at)
                 FROM legal_documents d2
                WHERE d2.slug = d.slug
           )
     ORDER BY slug
"""


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (
        request.headers.get("x-real-ip")
        or (fwd.split(",")[0].strip() if fwd else "")
        or "unknown"
    )


async def current_documents(cur: psycopg.AsyncCursor) -> list[dict]:
    """Documentos vigentes (uno por slug), ordenados."""
    await cur.execute(_CURRENT_SQL)
    return await cur.fetchall()


def terms_fingerprint(docs: list[dict]) -> str:
    """Huella de las versiones vigentes que EXIGEN aceptacion.

    Viaja al cliente en GET /legal/documents y vuelve en el registro. Si
    mientras alguien llenaba el formulario se publico una version nueva, el
    registro falla con 409 en vez de guardar la aceptacion de un texto que esa
    persona nunca vio. Los documentos informativos (el aviso de cookies) no
    entran en la huella: no se aceptan.
    """
    parts = sorted(
        f"{d['slug']}@{d['version']}" for d in docs if d["requires_acceptance"]
    )
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:16]


async def record_acceptances(
    cur: psycopg.AsyncCursor,
    *,
    docs: list[dict],
    user_id: int | None,
    venue_id: int | None,
    email: str | None,
    phone: str | None,
    ip: str,
    user_agent: str | None,
) -> int:
    """Registra la aceptacion de cada documento exigible. Devuelve cuantas filas
    se insertaron de verdad (idempotente: repetir no duplica la prueba)."""
    total = 0
    for d in docs:
        if not d["requires_acceptance"]:
            continue
        await cur.execute(
            """
            SELECT record_legal_acceptance(
                       %s, %s, %s, %s, %s, %s, %s, %s
                   ) AS inserted
            """,
            (user_id, venue_id, d["slug"], d["version"], email, phone, ip, user_agent),
        )
        row = await cur.fetchone()
        total += int(row["inserted"] or 0)
    return total


def _doc_path(slug: str) -> Path:
    if not _SLUG_RE.match(slug):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Documento no encontrado")
    return _LEGAL_DIR / f"{slug}.md"


# ---------------------------------------------------------------------------
# Publico: catalogo vigente
# ---------------------------------------------------------------------------
@router.get("/documents", response_model=LegalDocumentsOut)
async def list_documents(
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        docs = await current_documents(cur)
    return LegalDocumentsOut(
        terms_version=terms_fingerprint(docs),
        documents=[LegalDocumentOut(**d) for d in docs],
    )


# ---------------------------------------------------------------------------
# Publico: el texto de un documento
# ---------------------------------------------------------------------------
@router.get("/documents/{slug}", response_class=PlainTextResponse)
async def document_body(
    slug: str,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Markdown del documento vigente.

    Se valida contra la DB antes de leer el archivo: pedir un slug que no esta
    en el catalogo no toca el disco, y el nombre del archivo siempre sale de una
    fila existente.
    """
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM legal_documents WHERE slug = %s LIMIT 1", (slug,)
        )
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Documento no encontrado")

    path = _doc_path(slug)
    if not path.exists():
        # El catalogo y los archivos se separaron: es un error de despliegue,
        # no del usuario. 500 y no 404, para que no pase por "no existe".
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "El texto de este documento no esta desplegado",
        )
    return PlainTextResponse(
        path.read_text(encoding="utf-8"), media_type="text/markdown; charset=utf-8"
    )


# ---------------------------------------------------------------------------
# Autenticado: que acepte y que me falta
# ---------------------------------------------------------------------------
@router.get("/status", response_model=LegalStatusOut)
async def legal_status(
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT document_slug AS slug, document_version AS version, accepted_at
              FROM legal_acceptances
             WHERE user_id = %s
             ORDER BY accepted_at DESC
            """,
            (user["id"],),
        )
        accepted = await cur.fetchall()
        # `legal_missing_acceptances` responde en la DB la unica pregunta que
        # importa cuando los terminos cambian: cual version vigente me falta.
        # Devuelve SOLO las columnas de identidad del documento (slug, version,
        # title, url): el resto del tipo se completa abajo desde el catalogo.
        await cur.execute(
            "SELECT slug, version, title, url FROM legal_missing_acceptances(%s)",
            (user["id"],),
        )
        pending = await cur.fetchall()
        # El subconjunto se completa con el catalogo para que el frontend use un
        # solo tipo (LegalDocumentOut) en las dos listas.
        docs = {d["slug"]: d for d in await current_documents(cur)}

    return LegalStatusOut(
        accepted=[LegalAcceptanceOut(**a) for a in accepted],
        pending=[LegalDocumentOut(**{**docs[p["slug"]], **p}) for p in pending],
    )


# ---------------------------------------------------------------------------
# Publico: registrar una aceptacion
# ---------------------------------------------------------------------------
@router.post(
    "/acceptances",
    response_model=LegalAcceptanceOut,
    status_code=status.HTTP_201_CREATED,
)
@limiter.limit("120/hour")
async def accept_document(
    request: Request,
    body: LegalAcceptanceCreate,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Registra que alguien acepto una version concreta de un documento.

    El sujeto puede ser una cuenta (token en el header) o un invitado sin cuenta
    (telefono y/o correo). Si viene el token de la boleta, la aceptacion queda
    ademas atribuida al venue de esa boleta: asi el bar puede probar que quien
    entro acepto los terminos, sin guardar nunca el token crudo.

    Rate limit generoso (120/hora) a proposito: la puerta de un bar puede tener
    decenas de invitados detras del mismo NAT y cada uno registra su aceptacion
    una sola vez. Un limite estrecho bloquearia el flujo legitimo; el endpoint
    es idempotente y escribe una fila diminuta.
    """
    user = None
    auth = request.headers.get("authorization")
    if auth:
        # Token presente pero invalido = 401, no "anonimo": registrar la
        # aceptacion bajo un sujeto equivocado es peor que rechazar.
        user = await get_current_user(auth, db)

    ip = _client_ip(request)
    user_agent = (request.headers.get("user-agent") or "")[:400] or None

    venue_id: int | None = None
    phone = body.subject_phone
    email = body.subject_email

    async with db.cursor() as cur:
        if user:
            email = email or user["email"]
            # Una venue concreta cuando es inequivoca; si el usuario administra
            # varias, la aceptacion queda a nivel de cuenta (venue_id NULL) y no
            # se le atribuye a un bar que quiza no era.
            venue_id = user["venue_ids"][0] if len(user["venue_ids"]) == 1 else None

        if body.ticket_token:
            await cur.execute(
                """
                SELECT e.venue_id, t.customer_phone, t.customer_email
                  FROM tickets t
                  JOIN events e ON e.id = t.event_id
                 WHERE t.token_hash = encode(digest(%s, 'sha256'), 'hex')
                """,
                (body.ticket_token,),
            )
            ticket = await cur.fetchone()
            if not ticket:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Boleta no encontrada")
            venue_id = ticket["venue_id"]
            phone = phone or ticket["customer_phone"]
            email = email or ticket["customer_email"]

        # El sujeto tiene que poder identificarse: una fila de aceptacion sin
        # forma de atribuirla no prueba nada (mismo CHECK que exige la DB).
        if user is None and not email and not phone:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Falta el correo o el telefono de quien acepta.",
            )

        await cur.execute(
            """
            SELECT version, requires_acceptance
              FROM legal_documents
             WHERE slug = %s
             ORDER BY created_at DESC
             LIMIT 1
            """,
            (body.slug,),
        )
        doc = await cur.fetchone()
        if not doc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Documento no encontrado")
        if body.version != doc["version"]:
            # La version aceptada ya no es la vigente: el cliente tiene que
            # recargar y mostrar el texto que realmente rige.
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Hay una version nueva de este documento. Recarga la pagina.",
            )

        await cur.execute(
            """
            SELECT record_legal_acceptance(
                       %s, %s, %s, %s, %s, %s, %s, %s
                   ) AS inserted
            """,
            (
                user["id"] if user else None, venue_id, body.slug, body.version,
                email, phone, ip, user_agent,
            ),
        )
        inserted = int((await cur.fetchone())["inserted"] or 0)
        # Se devuelve la fecha de la fila que acaba de existir. `IS NOT
        # DISTINCT FROM` compara tambien los NULL: en el caso anonimo la
        # identidad son el correo y el telefono, no el user_id.
        await cur.execute(
            """
            SELECT accepted_at
              FROM legal_acceptances
             WHERE document_slug = %s AND document_version = %s
               AND user_id       IS NOT DISTINCT FROM %s
               AND subject_email IS NOT DISTINCT FROM %s
               AND subject_phone IS NOT DISTINCT FROM %s
             ORDER BY accepted_at DESC
             LIMIT 1
            """,
            (body.slug, body.version, user["id"] if user else None, email, phone),
        )
        row = await cur.fetchone()
        await db.commit()

    if not row:
        # Imposible salvo carrera con un DELETE: el INSERT de arriba garantiza
        # la fila. Se responde sin fecha en vez de inventarla.
        raise HTTPException(
            status.HTTP_409_CONFLICT, "No se pudo confirmar la aceptacion."
        )

    # `inserted == 0` es un caso normal (ya la habia aceptado): la respuesta
    # sigue siendo 201 con la fecha original, no un error.
    return LegalAcceptanceOut(
        slug=body.slug, version=body.version, accepted_at=row["accepted_at"]
    )
