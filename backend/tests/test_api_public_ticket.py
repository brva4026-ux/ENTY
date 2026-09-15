"""Entrega pública de la boleta por link (`/public/tickets/<token>/image.jpg`).

Es el link que le llega al cliente por WhatsApp: no tiene sesión, así que el
endpoint es público y el token crudo del QR es el secreto.
"""
JPEG_MAGIC = b"\xff\xd8\xff"


def _url(ticket) -> str:
    return f"/public/tickets/{ticket['raw_token']}/image.jpg"


def _emit_one(api, scen, name: str = "Ana Pérez") -> dict:
    return api.emit(
        "promoter",
        scen["venue"],
        scen["event"],
        ticket_type_id=scen["type"],
        allocation_id=scen["allocation"]["id"],
        customer_name=name,
    )


def test_client_gets_the_ticket_image_without_a_session(api_client, api):
    scen = api.scenario()
    ticket = _emit_one(api, scen)

    res = api_client.get(_url(ticket))  # sin Authorization a propósito
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/jpeg"
    assert res.content.startswith(JPEG_MAGIC)


def test_image_is_not_cached_nor_indexed(api_client, api):
    scen = api.scenario()
    ticket = _emit_one(api, scen)

    res = api_client.get(_url(ticket))
    assert "no-store" in res.headers["cache-control"]
    assert "noindex" in res.headers["x-robots-tag"]


def test_unknown_token_is_not_found(api_client):
    assert api_client.get("/public/tickets/token-que-no-existe/image.jpg").status_code == 404


def test_voided_ticket_link_is_gone(api_client, api):
    scen = api.scenario(alloc_capacity=1)
    ticket = _emit_one(api, scen)

    void = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets/{ticket['ticket_id']}/void",
        "admin",
        {"reason": "prueba de anulación"},
    )
    assert void.status_code == 200

    # El link ya circuló por WhatsApp: 410 explícito en vez de un QR que la
    # puerta va a rechazar.
    assert api_client.get(_url(ticket)).status_code == 410


def test_redeemed_ticket_still_renders(api_client, api):
    """El cliente puede reabrir su boleta; quien decide si entra es la puerta."""
    scen = api.scenario()
    ticket = _emit_one(api, scen)

    redeem = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/redeem",
        "bouncer",
        {"raw_token": ticket["raw_token"]},
    )
    assert redeem.status_code == 200
    assert redeem.json()["code"] == "GRANTED"

    assert api_client.get(_url(ticket)).status_code == 200
