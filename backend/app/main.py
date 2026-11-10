"""TicketFlow API — FastAPI application factory."""
import asyncio
import logging
import sys
import time
from contextlib import asynccontextmanager

if sys.platform == "win32":
    # psycopg en modo async no es compatible con ProactorEventLoop (default
    # de Windows); SelectorEventLoop sí lo es. Debe fijarse antes de que
    # uvicorn cree el loop (la policy se aplica en asyncio.run).
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import psycopg

from app.core.config import get_settings
from app.core.db import _CONNECT_KWARGS, close_pool, init_pool
from app.core.observability import (
    capture_exception,
    capture_message,
    init_sentry,
    sentry_active,
)
from app.core.push_worker import push_outbox_worker
from app.core.schema_guard import verify_schema_at_boot
from app.routers import (
    analytics,
    auth,
    invitations,
    events,
    legal,
    lifecycle,
    media,
    notifications,
    public,
    public_tickets,
    push,
    payouts,
    redemptions,
    report,
    seed,
    team,
    event_staff,
    scanner,
    tickets,
    waitlist,
    payments,
)


logger = logging.getLogger("ticketflow.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Sentry para el servidor directo (uvicorn local / cualquier host no
    # serverless). En Vercel lo inicializa antes api/index.py, para cubrir
    # también el fallo de import; init_sentry es idempotente.
    init_sentry()
    settings = get_settings()
    await init_pool(settings.database_url)
    # Guard de esquema (mig pendientes): si la base esta atras del codigo, el
    # log y Sentry lo dicen con el nombre exacto. NO impide el arranque: una
    # ruta rota es mejor que la API entera caida. En serverless no corre aqui
    # (el lifespan no se dispara en cada invocacion); /health lo cubre on-demand.
    app.state.schema_drift = verify_schema_at_boot(settings.database_url)
    # Worker del outbox de push (mig 014): las notificaciones in-app nacen en
    # triggers SQL; este loop envía el Web Push de cada una fuera de la
    # transacción de negocio. Solo corre con VAPID configurado; en serverless
    # cada arranque de función drena lo pendiente y el intervalo acota la
    # ventana de espera.
    push_stop = asyncio.Event()
    push_task = asyncio.create_task(push_outbox_worker(push_stop))
    try:
        yield
    finally:
        push_stop.set()
        push_task.cancel()
        results = await asyncio.gather(push_task, return_exceptions=True)
        # Un worker que murió con excepción es un hallazgo real: sin esto, el
        # push se apaga silenciosamente hasta el próximo arranque.
        for r in results:
            if isinstance(r, BaseException):
                capture_exception(r, context={"component": "push_outbox_worker"})
        await close_pool()


def create_app() -> FastAPI:
    settings = get_settings()
    # Cache del latido de /health, por instancia de la app (creada en
    # create_app para que tests con apps separadas no compartan estado).
    _health: dict = {"at": 0.0, "ok": None, "latency_ms": None}
    # Cache propia del chequeo de esquema: es mas caro (tres lecturas al
    # catalogo en su conexion) y el drift cambia con una migracion, no cada
    # 5 s. Una ventana mas larga evita abrir una conexion extra por probe.
    _schema_cache: dict = {"at": 0.0, "state": None}
    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        description="Sistema de boleteria y control de aforo (Etapa 0 MVP)",
        lifespan=lifespan,
        root_path=settings.api_root_path,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Headers de seguridad en las respuestas de la API. La UI estática los
    # recibe de vercel.json; la función serverless es un origen aparte y los
    # necesita propios (un error HTML crudo no debe poder renderizarse en un
    # iframe ajeno, ni sniffearse como otro tipo).
    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        h = response.headers
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("X-Frame-Options", "DENY")
        h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        # La puerta usa cámara (escáner) y geolocalización (check-in); nada
        # más necesita permisos potentes desde el origen de la API.
        h.setdefault("Permissions-Policy", "camera=(self), geolocation=(self)")
        return response

    app.include_router(invitations.router)
    app.include_router(auth.router)
    app.include_router(legal.router)
    app.include_router(events.router)
    app.include_router(lifecycle.router)
    app.include_router(push.router)
    app.include_router(notifications.router)
    app.include_router(tickets.router)
    app.include_router(public_tickets.router)
    app.include_router(media.router)
    app.include_router(report.router)
    app.include_router(redemptions.router)
    app.include_router(team.router)
    app.include_router(event_staff.router)
    app.include_router(scanner.router)
    app.include_router(payouts.router)
    app.include_router(public.router)
    app.include_router(waitlist.router)
    app.include_router(payments.router)
    app.include_router(seed.router)
    app.include_router(analytics.router)

    @app.get("/health", tags=["ops"])
    async def health():
        """Latido operacional: la app esta viva Y la DB responde.

        Antes este endpoint respondia ok sin tocar la base: un sistema con la
        DB caida se monitoreaba verde. Ahora el chequeo es real y una DB
        muerta responde 503 con el detalle, para que la alerta llegue antes
        que el primer usuario. El ping usa la ruta efimera (la misma de
        serverless) con timeout propio: un healthcheck no se cuelga 30 s.

        El resultado se cachea 5 s por instancia: una salva de probes no debe
        abrir una connection storm contra el pooler (el endpoint es publico).
        """
        # push_enabled / email_enabled: telemetria operativa — que canales de
        # aviso estan ENCENDIDOS de verdad (sus env vars configuradas).
        push_enabled = bool(
            settings.vapid_public_key_b64 and settings.vapid_private_key_b64
        )
        body = {
            "app": settings.app_name,
            "push_enabled": push_enabled,
            "email_enabled": bool(settings.resend_api_key),
            # error_tracking: si Sentry esta realmente activo. Su ausencia en
            # produccion significa que un 500 no avisa a nadie; exponerlo aqui
            # lo hace visible desde el primer probe.
            "error_tracking": sentry_active(),
            # schema: "ok" si la base tiene todo lo que el codigo usa;
            # "behind" si falta algo (migracion sin aplicar); "unknown" si no
            # se pudo verificar. Se chequea on-demand (serverless no dispara el
            # lifespan), con cache propia mas larga que la del ping.
        }

        now = time.perf_counter()
        cached = now - _health["at"] < 5.0 and _health["ok"] is not None
        if cached:
            db_ok, db_ms = _health["ok"], _health["latency_ms"]
        else:
            t0 = time.perf_counter()
            try:
                conn = await psycopg.AsyncConnection.connect(
                    settings.database_url,
                    **{**_CONNECT_KWARGS, "connect_timeout": 3},
                )
                try:
                    async with conn.cursor() as cur:
                        await cur.execute("SELECT 1")
                        await cur.fetchone()
                finally:
                    await conn.close()
            except Exception:
                # No se reporta a Sentry en cada probe: el 503 es la senal y
                # un monitor caido ya genera su propia alerta.
                db_ok = False
            else:
                db_ok = True
            db_ms = round((time.perf_counter() - t0) * 1000)
            _health.update(at=now, ok=db_ok, latency_ms=db_ms)

        # Chequeo de esquema (drift de produccion), cacheado aparte (60 s): es
        # mas caro y el drift solo cambia con una migracion. Va en su PROPIO
        # try: un fallo aqui (p.ej. no se pudo leer db/schema.sql en el bundle)
        # NUNCA debe tumbar el probe de la DB — seria un 503 falso con la base
        # sana. El resultado queda en /health como senal, no bloquea nada.
        if db_ok and now - _schema_cache["at"] < 60.0 and _schema_cache["state"]:
            schema_state = _schema_cache["state"]
        elif not db_ok:
            # Sin DB no se puede verificar el esquema; no se reporta "behind"
            # (no es drift, es la base caida, que ya se dice con db=down).
            schema_state = "unknown"
        else:
            schema_state = "unknown"
            try:
                from app.core.schema_guard import check_schema_async

                conn = await psycopg.AsyncConnection.connect(
                    settings.database_url,
                    **{**_CONNECT_KWARGS, "connect_timeout": 3},
                )
                try:
                    drift = await check_schema_async(conn)
                finally:
                    await conn.close()
                schema_state = "ok" if drift.ok else "behind"
                _schema_cache.update(at=now, state=schema_state)
                if not drift.ok:
                    # Solo se reporta cuando el drift es REAL (el mensaje se
                    # deduplica en Sentry).
                    capture_message(
                        f"/health detecto esquema atrasado: {drift.summary()}",
                        level="error",
                    )
            except Exception:
                logger.warning(
                    "No se pudo verificar el esquema en /health", exc_info=True
                )

        body["db"] = "ok" if db_ok else "down"
        body["db_latency_ms"] = db_ms
        body["schema"] = schema_state
        if not db_ok:
            body["status"] = "degraded"
            return JSONResponse(status_code=503, content=body)
        body["status"] = "ok"
        return body

    return app


app = create_app()