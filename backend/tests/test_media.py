"""Media: flyer/logo subidos desde el navegador (mig 018).

La subida es un data-URL JSON (el navegador reduce la imagen antes), se
guarda en la tabla `media` y se sirve publica por GET /media/{id} con cache
inmutable. Aqui se verifica el contrato: solo imagenes, solo tamano razonable,
y el evento acepta /media/{id} como flyer_url sin que la guardia SSRF la
rechace (no hay fetch de red posible).
"""
import base64

# JPEG 1x1 real (minimo que un <img> acepta) para el roundtrip completo.
_PNG_1PX = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def test_upload_and_public_roundtrip(api, world):
    res = api.post(
        f"/venues/{world['venue_a']}/media", "admin", {"data_url": _PNG_1PX}
    )
    assert res.status_code == 201, res.text
    url = res.json()["url"]
    assert url.startswith("/media/")

    # Publico: sin token, el invitado pinta su boleta con esta imagen.
    got = api.client.get(url)
    assert got.status_code == 200
    assert got.headers["content-type"].startswith("image/png")
    raw = base64.b64decode(_PNG_1PX.split(",", 1)[1])
    assert got.content == raw
    assert "immutable" in got.headers["cache-control"]


def test_upload_rejects_non_image_and_garbage(api, world):
    base = f"/venues/{world['venue_a']}/media"

    # No es imagen
    res = api.post(
        base,
        "admin",
        {"data_url": "data:text/html;base64,PGI+aGk8L2I+"},
    )
    assert res.status_code == 422

    # Base64 roto
    res = api.post(
        base,
        "admin",
        {"data_url": "data:image/jpeg;base64,!!!no-es-base64!!"},
    )
    assert res.status_code == 422

    # Demasiado grande: ~500 KB de bytes reales superan el tope de 600 KB
    # una vez base64-ificados (~667 KB)… y el propio decodificado no: usar
    # bytes de 700 KB decodificados directamente.
    big = "A" * (700_000 // 3 * 4)
    res = api.post(
        base, "admin", {"data_url": f"data:image/jpeg;base64,{big}"}
    )
    assert res.status_code == 413


def test_upload_requires_admin_role(api, world):
    res = api.post(
        f"/venues/{world['venue_a']}/media", "promoter", {"data_url": _PNG_1PX}
    )
    assert res.status_code == 403


def test_event_accepts_media_url_and_rejects_javascript(api, world):
    # Subida valida -> el evento la acepta como flyer.
    up = api.post(
        f"/venues/{world['venue_a']}/media", "admin", {"data_url": _PNG_1PX}
    ).json()
    ev = api.create_event(
        "admin", world["venue_a"], flyer_url=up["url"]
    )
    assert ev["flyer_url"] == up["url"]

    # javascript: ni loco (se pinta en <img>, pero defense-in-depth).
    res = api.post(
        f"/venues/{world['venue_a']}/events",
        "admin",
        {
            "name": "Mal flyer",
            "starts_at": "2027-03-01T20:00:00+00:00",
            "capacity": 10,
            "flyer_url": "javascript:alert(1)",
        },
    )
    assert res.status_code == 422

    # Ruta /media inventada con basura: rechazada por shape.
    res = api.post(
        f"/venues/{world['venue_a']}/events",
        "admin",
        {
            "name": "Mal media",
            "starts_at": "2027-03-01T20:00:00+00:00",
            "capacity": 10,
            "flyer_url": "/media/../../etc/passwd",
        },
    )
    assert res.status_code == 422


def test_get_unknown_media_404(api, world):
    res = api.client.get("/media/999999")
    assert res.status_code == 404
