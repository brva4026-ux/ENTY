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
from app.routers import (
    auth,
    invitations,
    events,
    lifecycle,
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
    settings = get_settings()
    await init_pool(settings.database_url)
    yield
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
    app.include_router(tickets.router)
    app.include_router(public_tickets.router)
    app.include_router(report.router)
    app.include_router(team.router)
    app.include_router(payouts.router)
    app.include_router(public.router)
    app.include_router(seed.router)

    @app.get("/health", tags=["ops"])
    async def health():
        return {"status": "ok", "app": settings.app_name}

    return app


app = create_app()