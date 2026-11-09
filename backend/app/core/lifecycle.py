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
