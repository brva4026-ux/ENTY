"""TicketFlow API — FastAPI application factory."""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.db import close_pool, init_pool
from app.routers import auth, events, report, seed, tickets


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
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth.router)
    app.include_router(events.router)
    app.include_router(tickets.router)
    app.include_router(report.router)
    app.include_router(seed.router)

    @app.get("/health", tags=["ops"])
    async def health():
        return {"status": "ok", "app": settings.app_name}

    return app


app = create_app()