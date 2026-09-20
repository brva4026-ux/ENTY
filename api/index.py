"""Entry point serverless de Vercel para la API TicketFlow (FastAPI ASGI).

Vercel invoca /api/index.py para las rutas reescritas desde /api/* (ver
vercel.json). Este wrapper:
  1. Inicializa Sentry ANTES del import de app.main: si el import muere
     (FUNCTION_INVOCATION_FAILED, ya pasó con qrcode/Pillow fuera de
     requirements), el error llega a Sentry igual — es exactamente el modo de
     fallo más silencioso que existe aquí.
  2. Agrega backend/ al sys.path para importar `app.main`.
  3. Quita el prefijo /api del path (las rutas internas no lo llevan) y fija
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

# Sentry primero (usa la DSN de env; no-op si no está). El import del SDK va
# protegido: si sentry-sdk no estuviera instalado, la función arranca igual.
try:
    from app.core.observability import capture_exception, init_sentry

    init_sentry()
except Exception:  # noqa: BLE001 — el arranque jamás depende de Sentry
    capture_exception = None  # type: ignore[assignment]

try:
    from app.main import app as ticketflow_app  # noqa: E402
except Exception:  # noqa: BLE001 — reporta el FUNCTION_INVOCATION_FAILED real
    if capture_exception is not None:
        capture_exception(
            Exception("app.main no pudo importarse (la API entera cae con 500)"),
            context={"backend_dir": _BACKEND_DIR, "python": sys.version},
        )
    raise


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
