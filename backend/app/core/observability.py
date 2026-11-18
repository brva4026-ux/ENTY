"""Observabilidad: error tracking con Sentry, opcional por diseño.

Sin `SENTRY_DSN` configurada, TODO es no-op: la app funciona exactamente
igual (cero latencia, cero red, cero dependencia de que exista el servicio).
Con la DSN presente, cada excepción no manejada (500) —y las que capturamos
explícitamente— llega al dashboard de Sentry con stacktrace completo.

¿Por qué capturar también el fallo de import en el entrypoint serverless? El
incidente documentado (qrcode/Pillow fuera de api/requirements.txt) tumbaba
TODA la API con FUNCTION_INVOCATION_FAILED y nadie se enteraba: el error ocurría
antes de que existiera cualquier ruta. Con Sentry inicializado ANTES del import,
ese fallo se reporta igual.
"""
import logging
import os

logger = logging.getLogger("ticketflow.observability")

_DSN_CACHE: bool | None = None


def _in_production() -> bool:
    """Misma detección que `Settings.is_production`, sin construir Settings.

    Sentry se inicializa antes que nada (incluso antes del import de app.main),
    así que no puede depender de `get_settings()`. Reusa el helper de config
    para no tener dos definiciones de "producción" que se desincronicen.
    """
    from app.core.config import _vercel_production

    return (
        os.environ.get("ENVIRONMENT", "").strip().lower() == "production"
        or _vercel_production()
    )


def _dsn() -> str | None:
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    return dsn or None


def sentry_active() -> bool:
    """True si Sentry quedo inicializado en este proceso."""
    return _DSN_CACHE is True


def init_sentry() -> bool:
    """Inicializa Sentry si hay DSN. Devuelve True si quedó activo.

    Idempotente: llamarlo varias veces no rompe (sentry_sdk.init es seguro).
    Con traces_sample_rate=0 no envía trazas de performance: solo errores
    (el plan developer es de errores; las traces consumen cuota de más).

    En produccion SIN `SENTRY_DSN`, avisa fuerte: el modo "no-op silencioso"
    es comodo en local pero en produccion significa que un 500 no le llega a
    nadie. El aviso es a proposito ruidoso (WARNING con el nombre de la var)
    para que el deploy no quede sin observabilidad sin que se note.
    """
    global _DSN_CACHE
    dsn = _dsn()
    if not dsn:
        _DSN_CACHE = False
        if _in_production():
            logger.warning(
                "SENTRY_DSN no configurada en produccion: los errores 500 NO se "
                "reportan a ningun lado (error tracking desactivado). Define "
                "SENTRY_DSN en las env vars del hosting."
            )
        return False
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=dsn,
            environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
            # Sin traces ni profiles: solo errores (cuota mínima, señal máxima).
            traces_sample_rate=0.0,
            profiles_sample_rate=0.0,
            send_default_pii=False,  # nunca PII: nombres/teléfonos de invitados no viajan
            # El request (path, método) sí ayuda a ubicar el 500; el body NO
            # se envía por defecto en las integraciones ASGI.
            attach_stacktrace=True,
        )
        _DSN_CACHE = True
        logger.info("Sentry activo (environment=%s)", os.environ.get("SENTRY_ENVIRONMENT", "production"))
        return True
    except Exception:  # noqa: BLE001 — Sentry jamás debe romper el arranque
        logger.warning("No se pudo inicializar Sentry; continúa sin él", exc_info=True)
        _DSN_CACHE = False
        return False


def capture_exception(exc: BaseException, *, context: dict | None = None) -> None:
    """Reporta una excepción a Sentry si está activo; no-op si no.

    Seguro de llamar desde cualquier except: si Sentry no está inicializado o
    falla el envío, este helper se traga todo (el flujo de negocio manda).
    """
    if not _DSN_CACHE:
        return
    try:
        import sentry_sdk

        if context:
            with sentry_sdk.new_scope() as scope:
                for k, v in context.items():
                    scope.set_extra(k, v)
                sentry_sdk.capture_exception(exc)
        else:
            sentry_sdk.capture_exception(exc)
    except Exception:  # noqa: BLE001
        pass


def capture_message(message: str, *, level: str = "error") -> None:
    """Reporta un mensaje (p.ej. condición rara que no es excepción)."""
    if not _DSN_CACHE:
        return
    try:
        import sentry_sdk

        sentry_sdk.capture_message(message, level=level)
    except Exception:  # noqa: BLE001
        pass


def log_security_event(kind: str, **fields) -> None:
    """Registra un evento de seguridad en un formato único y buscable.

    Cubre la actividad que no es un error de la app pero que hay que poder
    revisar: credenciales fallidas, bloqueos por fuerza bruta y peticiones de
    origen cruzado rechazadas (posible CSRF). Escribe SIEMPRE en el log del
    proceso (visible en los logs de Vercel) y, con Sentry activo, como mensaje
    de nivel warning para que un patrón (misma IP, muchos intentos) se vea sin
    leer logs a mano. Los valores van en la misma línea `clave=valor` para que
    un grep por `kind=login_failed` o `ip=` los agrupe.
    """
    parts = " ".join(f"{k}={v}" for k, v in fields.items() if v not in (None, ""))
    message = f"security_event kind={kind} {parts}".strip()
    logger.warning(message)
    capture_message(message, level="warning")
