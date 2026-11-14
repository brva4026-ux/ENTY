"""Watchdog de ciclo de vida de eventos, compartido entre routers.

`auto_close_expired_events()` (mig 020, gracia de 6 h en mig 034) cierra los
eventos cuya ventana venció. En serverless no hay cron: el cierre solo ocurre
cuando alguien toca una ruta que lo dispara. Antes solo lo hacía `GET /events`
(panel del admin), así que un evento vencido podía quedar "En puerta" para el
promotor, la puerta y la vitrina pública hasta que un admin abriera su panel.

Ley de Tesler: una automatización que depende de que alguien pase por una
pantalla no es una automatización. Se dispara desde varias rutas de LECTURA
(baratas, con índice parcial; sin vencidos no hacen nada) para que el cierre
ocurra sin importar por dónde entre el usuario.

La llamada NUNCA debe tumbar la lectura que la invoca: si la función no existe
(DB sin la migración) o falla, se hace rollback —la transacción queda limpia—
y se sigue con la consulta real. El error se reporta, no se propaga.
"""
import time

import psycopg

from app.core.observability import capture_exception


async def auto_close_expired(db, *, context: str) -> None:
    """Dispara el watchdog de cierre. Best-effort: nunca lanza."""
    try:
        async with db.cursor() as cur:
            await cur.execute("SELECT auto_close_expired_events()")
    except psycopg.Error as e:
        await db.rollback()
        capture_exception(e, context={"kind": "watchdog_auto_close", "from": context})


async def remind_upcoming_events(db, *, context: str) -> None:
    """Avisa "tu evento empieza pronto" (mig 043). Best-effort: nunca lanza.

    Mismo patrón que el cierre: no hay cron en serverless, así que el aviso se
    dispara desde lecturas baratas. `notify_event_reminders` marca cada evento
    al avisar (reminded_at), así que llamarlo de más es inofensivo: solo
    trabaja una vez por evento.
    """
    try:
        async with db.cursor() as cur:
            await cur.execute("SELECT notify_event_reminders()")
    except psycopg.Error as e:
        await db.rollback()
        capture_exception(e, context={"kind": "watchdog_event_reminder", "from": context})


# La poda de retención (mig 046) no es un límite de seguridad: es mantenimiento.
# Correrla en cada lectura sería un DELETE por request sin necesidad. Este
# throttle en proceso la limita a una vez por ventana POR INSTANCIA; como es
# idempotente y barata cuando no hay nada viejo, la redundancia entre instancias
# es inofensiva (a diferencia del rate limit, aquí la corrección no depende del
# estado compartido: el DELETE es correcto sin importar quién lo dispare).
_PRUNE_EVERY_SECONDS = 3600.0
_last_prune: float = 0.0


async def prune_expired_rows(db, *, context: str) -> None:
    """Poda las tablas que crecen (mig 046). Best-effort: nunca lanza."""
    global _last_prune
    now = time.monotonic()
    if now - _last_prune < _PRUNE_EVERY_SECONDS:
        return
    _last_prune = now
    try:
        async with db.cursor() as cur:
            await cur.execute("SELECT prune_expired()")
    except psycopg.Error as e:
        await db.rollback()
        capture_exception(e, context={"kind": "retention_prune", "from": context})
