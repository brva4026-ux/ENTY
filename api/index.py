"""Entry point serverless de Vercel para la API TicketFlow (FastAPI ASGI).

Vercel invoca /api/index.py para las rutas reescritas desde /api/* (ver
vercel.json). Este wrapper:
  1. Agrega backend/ al sys.path para importar `app.main`.
  2. Quita el prefijo /api del path (las rutas internas no lo llevan) y fija
     root_path="/api" solo como metadato para docs/OpenAPI. Hacerlo aqui es
     determinista e independiente del comportamiento de Starlette.
"""
import os
import sys

_BACKEND_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"
)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.main import app as ticketflow_app  # noqa: E402


class APIPrefixMiddleware:
    """Reescribe /api/<path> -> /<path> antes del router interno."""

    def __init__(self, asgi_app):
        self.asgi_app = asgi_app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path == "/api":
                path = "/"
            elif path.startswith("/api/"):
                path = path[len("/api"):]
            scope = dict(scope, path=path, root_path="/api")
        await self.asgi_app(scope, receive, send)


app = APIPrefixMiddleware(ticketflow_app)
