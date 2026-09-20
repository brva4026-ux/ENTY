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


def _dsn() -> str | None:
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    return dsn or None


def init_sentry() -> bool:
    """Inicializa Sentry si hay DSN. Devuelve True si quedó activo.

    Idempotente: llamarlo varias veces no rompe (sentry_sdk.init es seguro).
    Con traces_sample_rate=0 no envía trazas de performance: solo errores
    (el plan developer es de errores; las traces consumen cuota de más).
    """
    global _DSN_CACHE
    dsn = _dsn()
    if not dsn:
        _DSN_CACHE = False
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
