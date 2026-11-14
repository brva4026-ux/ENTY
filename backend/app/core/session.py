"""Cookie de sesion web; los clientes API conservan soporte Bearer."""
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from app.core.config import get_settings

COOKIE_NAME = "tf_session"


def check_session_origin(request: Request, *, required: bool = False) -> None:
    origin = request.headers.get("origin")
    allowed = {f"{request.url.scheme}://{request.url.netloc}", get_settings().app_public_url.rstrip('/')}
    allowed.update(get_settings().cors_origins_list)
    if (required and not origin) or (origin and origin not in allowed):
        raise HTTPException(403, "Origen de la solicitud no permitido")


def set_session_cookie(response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        COOKIE_NAME, token, httponly=True, secure=settings.environment == "production",
        samesite="lax", max_age=settings.jwt_expires_minutes * 60, path="/",
    )
    response.headers["Cache-Control"] = "no-store"


def session_response(token: str, user, *, status_code: int = 200):
    # access_token se mantiene solo por compatibilidad con clientes API;
    # el navegador usa la cookie y no persiste el token en JavaScript.
    response = JSONResponse({"access_token": token, "token_type": "bearer",
                             "user": user.model_dump(mode="json")}, status_code=status_code)
    set_session_cookie(response, token)
    return response
