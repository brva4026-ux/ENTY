"""Cliente Wompi (pagos Colombia, mig 023).

Lo minimo que la integracion necesita, sin SDK: crear links de pago
(`POST /v1/payment_links`, monto fijo + single_use + expiracion) y consultar
una transaccion (`GET /v1/transactions/{id}`) para verificar pagos dudosos.

La firma del webhook NO vive aqui (es puro hashlib, vive en el router) y el
monto/cobro jamas se confia a este cliente: la fuente de verdad es la tabla
ticket_payments.
"""
import httpx
from app.core.config import get_settings


class WompiError(Exception):
    """Wompi rechazo la peticion o respondio algo inesperado."""


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {get_settings().wompi_private_key}",
        "Content-Type": "application/json",
    }


async def create_payment_link(
    *, name: str, description: str, amount_in_cents: int,
    expires_at_iso: str, redirect_url: str | None = None,
) -> dict:
    """Crea un link de pago single-use de monto fijo.

    Devuelve el JSON de Wompi (data.id es el payment_link_id, data.slug
    arma la URL publica). Lanza WompiError si la API rechaza: el router lo
    traduce a 502 y el cobro NO queda creado en ticket_payments (la DB
    registra solo lo que Wompi acepto).
    """
    s = get_settings()
    # OJO: payment_links NO soporta reference por transaccion (eso es del
    # checkout web). La ligazon webhook -> cobro es payment_link_id ->
    # ticket_payments.provider_ref (UNIQUE parcial en la mig 023).
    payload = {
        "name": name[:100],
        "description": description[:200],
        "single_use": True,          # una boleta = un pago: despues muere
        "collect_shipping": False,
        "currency": "COP",           # unica moneda soportada por Wompi
        "amount_in_cents": amount_in_cents,
        "expires_at": expires_at_iso,
        "redirect_url": redirect_url,
    }
    payload = {k: v for k, v in payload.items() if v is not None}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(
                f"{s.wompi_base_url}/payment_links",
                json=payload,
                headers=_headers(),
            )
    except httpx.HTTPError as e:
        raise WompiError(f"Wompi inalcanzable: {e}") from e
    if res.status_code >= 400:
        raise WompiError(f"Wompi rechazo el link ({res.status_code}): {res.text[:300]}")
    data = res.json()
    link = data.get("data") or {}
    if not link.get("id"):
        raise WompiError(f"Respuesta de Wompi sin id de link: {str(data)[:300]}")
    return link


def link_public_url(link: dict) -> str:
    """URL publica del checkout a partir del slug/id que devuelve la API."""
    base = (
        "https://checkout.wompi.co/l/"
        if get_settings().wompi_env != "prod"
        else "https://checkout.wompi.co/p/"
    )
    return f"{base}{link.get('slug') or link.get('id')}"


async def get_transaction(transaction_id: str) -> dict:
    """Consulta una transaccion (verificacion activa del webhook)."""
    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.get(
                f"{s.wompi_base_url}/transactions/{transaction_id}",
                headers=_headers(),
            )
    except httpx.HTTPError as e:
        raise WompiError(f"Wompi inalcanzable: {e}") from e
    if res.status_code >= 400:
        raise WompiError(f"Transaccion {transaction_id}: HTTP {res.status_code}")
    return (res.json() or {}).get("data") or {}
