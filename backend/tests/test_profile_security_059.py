"""Perfil (mig 059): contacto con permiso, sesiones y estado de push.

Lo que se comprueba aquí es la regla de producto: guardar un dato no lo
publica, y la UI solo puede afirmar un estado que el servidor confirmó.
"""


def _login(api, who="promoter"):
    return api.client.post(
        "/auth/login",
        json={
            "email": api.world[who]["email"],
            "password": api.world["password"],
        },
    ).json()["access_token"]


def test_profile_contact_requires_share_flag(api):
    res = api.patch(
        "/auth/profile",
        "promoter",
        {
            "full_name": "Promotor Contacto",
            "contact_email": "contacto@equipo.test",
            "share_contact_with_team": True,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["contact_email"] == "contacto@equipo.test"
    assert body["share_contact_with_team"] is True

    # Apagar el permiso no borra el dato: solo deja de compartirse.
    res = api.patch(
        "/auth/profile",
        "promoter",
        {"full_name": "Promotor Contacto", "share_contact_with_team": False},
    )
    assert res.status_code == 200, res.text
    assert res.json()["contact_email"] == "contacto@equipo.test"
    assert res.json()["share_contact_with_team"] is False


def test_venue_contact_needs_explicit_channel(api, api_client):
    venue = api.world["venue_a"]
    res = api.patch(
        f"/auth/venues/{venue}",
        "admin",
        {
            "contact_name": "Reservas",
            "contact_phone": "573001112233",
            "contact_email": "reservas@local.test",
            "public_contact_enabled": False,
            "public_contact_channels": ["whatsapp", "email"],
        },
    )
    assert res.status_code == 200, res.text
    saved = res.json()
    assert saved["public_contact_enabled"] is False
    assert saved["contact_email"] == "reservas@local.test"

    event = api.create_event("admin", venue, name="Contacto apagado", capacity=10)
    api.publish("admin", venue, event["id"])
    body = api_client.get(f"/public/events/{event['id']}").json()
    assert body["contact_phone"] is None
    assert body["contact_email"] is None

    # Encender sin canales no publica nada (el schema lo rechaza).
    res = api.patch(
        f"/auth/venues/{venue}",
        "admin",
        {"public_contact_enabled": True, "public_contact_channels": []},
    )
    assert res.status_code == 422, res.text

    res = api.patch(
        f"/auth/venues/{venue}",
        "admin",
        {"public_contact_enabled": True, "public_contact_channels": ["email"]},
    )
    assert res.status_code == 200, res.text
    body = api_client.get(f"/public/events/{event['id']}").json()
    assert body["contact_phone"] is None
    assert body["contact_email"] == "reservas@local.test"


def test_sessions_are_listed_and_revoked_with_password(api):
    current = api.token("promoter")
    second = _login(api)

    rows = api.get("/auth/sessions", "promoter")
    assert rows.status_code == 200, rows.text
    listed = rows.json()
    assert len(listed) >= 2
    assert sum(1 for s in listed if s["current"]) == 1

    other = next(s for s in listed if not s["current"])
    wrong = api.client.request(
        "DELETE",
        f"/auth/sessions/{other['id']}",
        headers={"Authorization": f"Bearer {current}"},
        json={"password": "no-es-la-clave"},
    )
    assert wrong.status_code == 400

    ok = api.client.request(
        "DELETE",
        f"/auth/sessions/{other['id']}",
        headers={"Authorization": f"Bearer {current}"},
        json={"password": api.world["password"]},
    )
    assert ok.status_code == 200, ok.text

    dead = api.client.get(
        "/auth/me", headers={"Authorization": f"Bearer {second}"}
    )
    assert dead.status_code == 401
    alive = api.client.get(
        "/auth/me", headers={"Authorization": f"Bearer {current}"}
    )
    assert alive.status_code == 200


def test_push_status_does_not_claim_registration_without_endpoint(api):
    venue = api.world["venue_a"]
    res = api.get(
        f"/push/status?venue_id={venue}&permission=default&subscribed=false",
        "admin",
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["registered"] is False
    assert body["subscribed"] is False
    assert body["permission"] == "default"
