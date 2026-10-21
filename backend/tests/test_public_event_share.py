"""Tarjeta social de un evento (`/public/share/evento/{id}`).

WhatsApp no ejecuta JS: compartir `/evento/12` mostraba un link pelado porque
el HTML de la SPA es estatico. Vercel manda SOLO a los crawlers a este
endpoint (rewrite por User-Agent), asi que lo que importa aqui es: metaetiquetas
correctas y absolutas, JSON-LD valido, nada de borradores filtrados y ningun
nombre capaz de romper el HTML/JSON.
"""
from datetime import datetime, timezone
from html import escape
import json
import uuid

import pytest

from app.routers.public import _share_event_html


def _tag() -> str:
    return uuid.uuid4().hex[:8]


def _html(**over) -> str:
    base = dict(
        base_url="https://enty.test",
        event_id=42,
        name="Noche Electrónica",
        starts_at=datetime(2026, 11, 20, 1, 0, tzinfo=timezone.utc),
        tz_name="America/Bogota",
        venue="Bar Esquina",
        location="Bogotá, Colombia",
        flyer_url=None,
        min_price=3000000,
    )
    base.update(over)
    return _share_event_html(**base)


# --- Sin DB: la generacion del HTML es pura -------------------------------

def test_meta_tags_are_absolute_and_describe_the_event():
    html = _html()

    assert '<meta property="og:title" content="Noche Electrónica" />' in html
    # Sin flyer se cae a la portada de marca, siempre absoluta: WhatsApp no
    # resuelve rutas relativas.
    assert '<meta property="og:image" content="https://enty.test/og-cover.png" />' in html
    assert '<link rel="canonical" href="https://enty.test/evento/42" />' in html
    assert '<meta property="og:url" content="https://enty.test/evento/42" />' in html
    assert '<meta name="twitter:card" content="summary_large_image" />' in html
    # La descripcion lleva fecha local del evento y lugar.
    assert "Bar Esquina" in html and "Bogotá, Colombia" in html
    assert "19/11/2026" in html  # 01:00 UTC = 20:00 del dia anterior en Bogota


def test_flyer_url_is_used_and_normalized_to_absolute():
    assert "https://cdn.test/flyer.jpg" in _html(flyer_url="https://cdn.test/flyer.jpg")
    # Un flyer servido por la propia API llega sin host: se le pone el base.
    assert (
        '<meta property="og:image" content="https://enty.test/api/media/9.jpg" />'
        in _html(flyer_url="/api/media/9.jpg")
    )


def test_json_ld_is_valid_event_schema():
    html = _html()
    payload = html.split('<script type="application/ld+json">', 1)[1].split("</script>", 1)[0]
    data = json.loads(payload)

    assert data["@type"] == "Event"
    assert data["name"] == "Noche Electrónica"
    assert data["startDate"].startswith("2026-11-20T01:00")
    assert data["location"]["name"] == "Bar Esquina"
    assert data["location"]["address"] == "Bogotá, Colombia"
    assert data["offers"]["price"] == "30000.00"
    assert data["offers"]["priceCurrency"] == "COP"
    assert data["url"] == "https://enty.test/evento/42"


def test_free_event_has_no_offer():
    data = json.loads(
        _html(min_price=None)
        .split('<script type="application/ld+json">', 1)[1]
        .split("</script>", 1)[0]
    )
    assert "offers" not in data


def test_hostile_name_cannot_break_html_or_json():
    evil = 'Fiesta </script><script>alert(1)</script> " <b>'
    html = _html(name=evil)

    # El JSON-LD sigue siendo parseable: `</` se escapo dentro del script.
    payload = html.split('<script type="application/ld+json">', 1)[1].split("</script>", 1)[0]
    assert json.loads(payload)["name"] == evil
    # En los atributos el nombre va escapado, no crudo.
    assert escape(evil) in html
    assert "<script>alert(1)" not in html


# --- Con DB: el endpoint responde la tarjeta del evento --------------------

def test_endpoint_serves_published_event_and_hides_drafts(api, api_client):
    venue = api.world["venue_a"]
    tag = _tag()
    name = f"Shareado {tag}"
    event = api.create_event("admin", venue, name=name, capacity=50, location=f"Ciudad {tag}")
    api.add_type(
        "admin", venue, event["id"],
        name="General", price_cents=4500000, quantity=20, is_courtesy=False,
    )

    # Borrador: el link no debe filtrar un evento sin venta abierta.
    draft = api_client.get(f"/public/share/evento/{event['id']}")
    assert draft.status_code == 404, draft.text

    api.publish("admin", venue, event["id"])
    res = api_client.get(f"/public/share/evento/{event['id']}")

    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/html")
    body = res.text
    assert f'<meta property="og:title" content="{name}" />' in body
    assert f"/evento/{event['id']}" in body
    assert "45000.00" in body  # precio minimo en COP, desde la localidad paga

    data = json.loads(
        body.split('<script type="application/ld+json">', 1)[1].split("</script>", 1)[0]
    )
    assert data["@type"] == "Event" and data["name"] == name


def test_endpoint_404_for_unknown_event(api_client):
    assert api_client.get("/public/share/evento/99999999").status_code == 404
