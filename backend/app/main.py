"""Tickelot API — FastAPI application factory."""
import asyncio
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
from app.core.observability import capture_exception, init_sentry
from app.core.push_worker import push_outbox_worker
from app.routers import (
    auth,
    invitations,
    events,
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
    tickets,
    waitlist,
    payments,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Sentry para el servidor directo (uvicorn local / cualquier host no
    # serverless). En Vercel lo inicializa antes api/index.py, para cubrir
    # también el fallo de import; init_sentry es idempotente.
    init_sentry()
    settings = get_settings()
    await init_pool(settings.database_url)
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
    app.include_router(payouts.router)
    app.include_router(public.router)
    app.include_router(waitlist.router)
    app.include_router(payments.router)
    app.include_router(seed.router)

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

        body["db"] = "ok" if db_ok else "down"
        body["db_latency_ms"] = db_ms
        if not db_ok:
            body["status"] = "degraded"
            return JSONResponse(status_code=503, content=body)
        body["status"] = "ok"
        return body

    return app


app = create_app()