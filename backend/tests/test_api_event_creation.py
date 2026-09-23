"""Creación de eventos con fecha, descripción y flyer.

La fecha es donde es fácil equivocarse en silencio: el navegador manda un
`datetime-local` SIN zona horaria y el backend lo guarda en `timestamptz`. Si
la conversión se hace mal, el evento queda corrido varias horas y nadie se
entera hasta la puerta.
"""
from datetime import datetime, timezone

import pytest

# PNG 1x1 real (mismo que test_media): para flyers via /media/{id}.
_PNG_1PX = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def _post_event(api, venue_id, **extra):
    payload = {
        "name": "Noche Electrónica",
        "starts_at": "2026-11-20T20:00:00-05:00",  # = 01:00 UTC del 21
        "capacity": 250,
    }
    payload.update(extra)
    return api.post(f"/venues/{venue_id}/events", "admin", payload)


def test_create_event_with_date_description_and_flyer(api, world):
    # El flyer viaja como imagen subida (/media/{id}, mig 018): la guardia
    # SSRF resuelve DNS al validar URLs externas y en CI no hay red.
    media = api.post(
        f"/venues/{world['venue_a']}/media", "admin", {"data_url": _PNG_1PX}
    )
    assert media.status_code == 201, media.text
    flyer = media.json()["url"]

    res = _post_event(
        api,
        world["venue_a"],
        description="DJ set + open bar",
        flyer_url=flyer,
        ends_at="2026-11-21T02:00:00-05:00",  # = 07:00 UTC
        event_timezone="America/Bogota",
    )
    assert res.status_code == 201, res.text
    body = res.json()

    assert body["description"] == "DJ set + open bar"
    assert body["flyer_url"] == flyer
    assert body["event_timezone"] == "America/Bogota"
    assert body["capacity"] == 250
    assert body["status"] == "draft"

    # Lo que importa: queda guardado como INSTANTE, no como texto local.
    assert datetime.fromisoformat(body["starts_at"]) == datetime(
        2026, 11, 21, 1, 0, tzinfo=timezone.utc
    )
    assert datetime.fromisoformat(body["ends_at"]) == datetime(
        2026, 11, 21, 7, 0, tzinfo=timezone.utc
    )


def test_optional_fields_default_to_null(api, world):
    body = _post_event(api, world["venue_a"]).json()
    assert body["description"] is None
    assert body["flyer_url"] is None
    assert body["ends_at"] is None


def test_event_is_listed_with_its_full_data(api, world):
    venue = world["venue_a"]
    media = api.post(f"/venues/{venue}/media", "admin", {"data_url": _PNG_1PX})
    assert media.status_code == 201, media.text
    flyer = media.json()["url"]
    created = api.create_event(
        "admin",
        venue,
        name="Con flyer",
        description="Descripción del evento",
        flyer_url=flyer,
    )

    [listed] = api.get(f"/venues/{venue}/events", "admin").json()
    assert listed["id"] == created["id"]
    assert listed["description"] == "Descripción del evento"
    assert listed["flyer_url"] == flyer
    assert listed["event_timezone"] == created["event_timezone"]


def test_transition_returns_the_full_event(api, world):
    """La transición reemplaza el evento en el estado del frontend: una consulta
    recortada borraría la descripción y el flyer de la vista."""
    venue = world["venue_a"]
    media = api.post(
        f"/venues/{venue}/media", "admin", {"data_url": _PNG_1PX}
    )
    assert media.status_code == 201, media.text
    flyer = media.json()["url"]
    created = api.create_event(
        "admin",
        venue,
        name="Con flyer",
        description="DJ set + open bar",
        flyer_url=flyer,
    )

    published = api.publish("admin", venue, created["id"])
    assert published["description"] == "DJ set + open bar"
    assert published["flyer_url"] == flyer
    assert published["event_timezone"] == created["event_timezone"]
    assert published["starts_at"] == created["starts_at"]
    assert published["capacity"] == created["capacity"]


@pytest.mark.parametrize(
    "extra",
    [
        {"ends_at": "2026-11-20T19:00:00-05:00"},  # cierre antes de abrir
        {"ends_at": "2026-11-20T20:00:00-05:00"},  # cierre igual a la apertura
        {"flyer_url": "no-es-una-url"},
        {"flyer_url": "javascript:alert(1)"},
        {"capacity": 0},
        {"name": ""},
    ],
)
def test_invalid_event_payloads_are_rejected(api, world, extra):
    assert _post_event(api, world["venue_a"], **extra).status_code == 422
