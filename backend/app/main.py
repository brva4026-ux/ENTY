"""TicketFlow API — FastAPI application factory."""
import asyncio
import sys
from contextlib import asynccontextmanager

if sys.platform == "win32":
    # psycopg en modo async no es compatible con ProactorEventLoop (default
    # de Windows); SelectorEventLoop sí lo es. Debe fijarse antes de que
    # uvicorn cree el loop (la policy se aplica en asyncio.run).
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.db import close_pool, init_pool
from app.core.observability import capture_exception, init_sentry
from app.core.push_worker import push_outbox_worker
from app.routers import (
    auth,
    invitations,
    events,
    lifecycle,
    notifications,
    public,
    public_tickets,
    push,
    payouts,
    report,
    seed,
    team,
    tickets,
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

    app.include_router(invitations.router)
    app.include_router(auth.router)
    app.include_router(events.router)
    app.include_router(lifecycle.router)
    app.include_router(push.router)
    app.include_router(notifications.router)
    app.include_router(tickets.router)
    app.include_router(public_tickets.router)
    app.include_router(report.router)
    app.include_router(team.router)
    app.include_router(payouts.router)
    app.include_router(public.router)
    app.include_router(seed.router)

    @app.get("/health", tags=["ops"])
    async def health():
        # push_enabled: telemetría operativa — si VAPID no está configurado,
        # la campana in-app funciona pero el push del celular no; este campo
        # lo dice sin entrar al dashboard.
        push_enabled = bool(
            settings.vapid_public_key_b64 and settings.vapid_private_key_b64
        )
        return {
            "status": "ok",
            "app": settings.app_name,
            "push_enabled": push_enabled,
        }

    return app


app = create_app()