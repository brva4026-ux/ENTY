"""Cookie de sesion web; los clientes API conservan soporte Bearer."""
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.core.observability import log_security_event

COOKIE_NAME = "tf_session"


def check_session_origin(request: Request, *, required: bool = False) -> None:
    origin = request.headers.get("origin")
    allowed = {f"{request.url.scheme}://{request.url.netloc}", get_settings().app_public_url.rstrip('/')}
    allowed.update(get_settings().cors_origins_list)
    if (required and not origin) or (origin and origin not in allowed):
        # Origen ausente en una mutación por cookie, o un origen ajeno: es el
        # patrón de un CSRF. Queda registrado para poder verlo (una ráfaga
        # desde la misma IP es un ataque; una vez suelta suele ser un cliente
        # mal configurado).
        log_security_event(
            "cross_origin_rejected",
            origin=origin or "(ausente)",
            method=request.method,
            path=request.url.path,
        )
        raise HTTPException(403, "Origen de la solicitud no permitido")


def set_session_cookie(response, token: str, *, remember: bool = True) -> None:
    settings = get_settings()
    # "Recordarme" gobierna la VIDA de la cookie, no donde vive el token:
    # marcado (default) lleva max_age y sobrevive al cierre del navegador; sin
    # marcar es una cookie de sesion y muere con la pestaña (el modo compartido
    # de la puerta lo pide). El valor del token no cambia en ningun caso.
    response.set_cookie(
        COOKIE_NAME, token, httponly=True, secure=settings.is_production,
        samesite="lax", max_age=settings.jwt_expires_minutes * 60 if remember else None,
        path="/",
    )
    response.headers["Cache-Control"] = "no-store"


def session_response(token: str, user, *, status_code: int = 200, remember: bool = True):
    # access_token se mantiene solo por compatibilidad con clientes API;
    # el navegador usa la cookie y no persiste el token en JavaScript.
    response = JSONResponse({"access_token": token, "token_type": "bearer",
                             "user": user.model_dump(mode="json")}, status_code=status_code)
    set_session_cookie(response, token, remember=remember)
    return response
