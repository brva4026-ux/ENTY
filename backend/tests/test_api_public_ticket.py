"""Tests de la boleta publica del invitado.

El flujo que se protege: el promotor emite, le manda un ENLACE al invitado, y
el invitado abre ese enlace para ver su QR. Antes solo existia el QR pintado
en el navegador del promotor, asi que el invitado no tenia nada escaneable.
"""
import os

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
    ),
)
os.environ.setdefault("JWT_SECRET", "test-secret")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _seed(dbcur, slug: str) -> dict:
    dbcur.execute(
        "INSERT INTO venues (name, slug) VALUES (%s, %s) "
        "ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id",
        (f"Venue {slug}", slug),
    )
    vid = dbcur.fetchone()["id"]
    dbcur.execute("DELETE FROM events WHERE name=%s", (f"Evento {slug}",))
    dbcur.execute(
        "INSERT INTO events (venue_id, name, starts_at, capacity, status) "
        "VALUES (%s, %s, now() + interval '3 days', 100, 'published') RETURNING id",
        (vid, f"Evento {slug}"),
    )
    eid = dbcur.fetchone()["id"]
    dbcur.execute(
        "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) "
        "VALUES (%s, 'General', 0, 50, TRUE) RETURNING id",
        (eid,),
    )
    tid = dbcur.fetchone()["id"]
    return {"venue_id": vid, "event_id": eid, "type_id": tid}


def _emit(dbcur, s: dict, raw_token: str, name: str = "Ana Perez") -> int:
    dbcur.execute(
        "SELECT emit_ticket(%s, %s, NULL, NULL, %s, %s, NULL, NULL)",
        (s["event_id"], s["type_id"], name, raw_token),
    )
    return dbcur.fetchone()["emit_ticket"]


def test_preview_returns_ticket_for_valid_token(client, dbcur):
    """El invitado abre el enlace: debe ver evento, venue y su nombre."""
    s = _seed(dbcur, "pub-ok")
    _emit(dbcur, s, "token-publico-valido-123")

    r = client.post("/tickets/preview", json={"raw_token": "token-publico-valido-123"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["customer_name"] == "Ana Perez"
    assert d["event_name"] == "Evento pub-ok"
    assert d["venue_name"] == "Venue pub-ok"
    assert d["status"] == "issued"
    assert d["starts_at"], "la fecha formateada no puede venir vacia"


def test_preview_rejects_unknown_token(client, dbcur):
    """Un token que no existe no debe filtrar si hay boletas o no."""
    _seed(dbcur, "pub-malo")
    r = client.post("/tickets/preview", json={"raw_token": "token-que-no-existe-999"})
    assert r.status_code == 404


def test_preview_is_not_authenticated(client):
    """Sin header Authorization: el invitado no tiene cuenta."""
    r = client.post("/tickets/preview", json={"raw_token": "lo-que-sea-12345"})
    assert r.status_code != 401, "el endpoint no debe exigir login"


def test_preview_hides_contact_pii(client, dbcur):
    """El telefono/correo del invitado no viaja en la respuesta publica."""
    s = _seed(dbcur, "pub-pii")
    dbcur.execute(
        "SELECT emit_ticket(%s, %s, NULL, NULL, %s, %s, %s, %s)",
        (s["event_id"], s["type_id"], "Con PII", "token-con-pii-12345",
         "573001112233", "asistente@correo.com"),
    )

    r = client.post("/tickets/preview", json={"raw_token": "token-con-pii-12345"})
    assert r.status_code == 200, r.text
    body = r.text
    assert "573001112233" not in body
    assert "asistente@correo.com" not in body


def test_image_returns_jpeg_with_qr(client, dbcur):
    """La imagen de la boleta debe ser un JPEG real (no un error en JSON)."""
    s = _seed(dbcur, "pub-img")
    _emit(dbcur, s, "token-imagen-123456")

    r = client.post("/tickets/image", json={"raw_token": "token-imagen-123456"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/jpeg"
    # cabecera magica de JPEG
    assert r.content[:2] == b"\xff\xd8", "el cuerpo no es un JPEG"
    assert len(r.content) > 5000, "la imagen parece vacia"
    # el QR lleva el token: no debe quedar cacheada en ningun intermediario
    assert "no-store" in r.headers.get("cache-control", "")


def test_image_rejects_unknown_token(client, dbcur):
    _seed(dbcur, "pub-img-malo")
    r = client.post("/tickets/image", json={"raw_token": "token-inexistente-999"})
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/json")


def test_image_qr_decodes_to_token(client, dbcur):
    """El QR dentro de la imagen debe contener el token escaneable.

    Es el punto del ticket: el bouncer escanea la imagen, no un texto copiado.
    """
    import io

    import qrcode
    from PIL import Image

    s = _seed(dbcur, "pub-qr")
    token = "token-escaneable-abcdef123456"
    _emit(dbcur, s, token)

    r = client.post("/tickets/image", json={"raw_token": token})
    assert r.status_code == 200, r.text

    # No hay decoder de QR entre las dependencias, asi que se compara el area
    # del QR contra una referencia generada con el mismo token y parametros
    # (qrcode es determinista). El JPEG es con perdida, de ahi la tolerancia:
    # medido, el mismo token difiere <=15 y un token distinto llega a 255.
    img = Image.open(io.BytesIO(r.content)).convert("RGB")
    ref = qrcode.QRCode(border=1, error_correction=qrcode.constants.ERROR_CORRECT_M)
    ref.add_data(token)
    ref.make(fit=True)
    ref_img = ref.make_image(fill_color="black", back_color="white").convert("RGB")
    ref_img = ref_img.resize((260, 260), Image.LANCZOS)

    # el QR se pega en (ancho-300, 130) segun ticket_image.py
    w = img.size[0]
    crop = img.crop((w - 300, 130, w - 300 + 260, 130 + 260))
    a, b = crop.tobytes(), ref_img.tobytes()
    peor = max(abs(x - y) for x, y in zip(a, b))
    assert peor <= 40, f"el QR no coincide con el token (diferencia maxima {peor})"
