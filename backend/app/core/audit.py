"""Escritura de auditoria (mig 019).

Un solo lugar para las acciones de dinero y datos personales que no tenian
rastro propio: cambios de precio/cupo de tipos, cupos de promotor y
exportaciones CSV. Las demas ya viven en tablas especificas (redemptions,
ticket_reissues, ticket_contact_edits, promoter_payouts.reviewed_by) y no se
duplican aqui.

El INSERT nunca rompe la accion del usuario: si la auditoria falla, la
operacion de negocio ya esta hecha y hay que responderle al cliente igual.
El error queda en los logs (observability) para investigarse.
"""
import logging

import psycopg
from psycopg.types.json import Json

log = logging.getLogger("audit")


async def write_audit(
    cur,
    venue_id: int,
    actor_id: int | None,
    kind: str,
    entity: str,
    entity_id: int | None,
    details: dict,
) -> None:
    try:
        await cur.execute(
            """
            INSERT INTO audit_log (venue_id, actor_id, kind, entity, entity_id, details)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (venue_id, actor_id, kind, entity, entity_id, Json(details)),
        )
    except (psycopg.Error, TypeError, ValueError) as e:
        # La operacion de negocio ya se realizo: la auditoria no puede
        # convertirse en un 500 delante del usuario.
        log.warning("audit_log insert fallo (kind=%s): %s", kind, e)
