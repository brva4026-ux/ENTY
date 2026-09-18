"""Tests de registro self-service y de las guardas de confirmación.

- POST /auth/register crea venue + admin y devuelve sesión válida.
- Email duplicado se rechaza (409).
- DELETE .../users/{id}/purge exige confirmar el email exacto.
- DELETE .../events/{id} exige confirmar el nombre exacto y solo borra
  en draft/cancelled.
"""


def test_register_creates_venue_and_admin(api):
    payload = {
        "venue_name": "Teatro Registro",
        "full_name": "Dueño Registro",
        "email": "dueno-registro@example.test",
        "password": "ClaveRegistro1",
    }
    res = api.client.post("/auth/register", json=payload)
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["access_token"]
    assert body["user"]["email"] == payload["email"]
    assert list(body["user"]["roles"].values()) == [["admin"]]
    assert body["user"]["venues"][0]["name"] == "Teatro Registro"

    # El password dado sirve para iniciar sesión.
    login = api.client.post(
        "/auth/login",
        json={"email": payload["email"], "password": payload["password"]},
    )
    assert login.status_code == 200


def test_register_duplicate_email_conflict(api):
    payload = {
        "venue_name": "Teatro Dup",
        "full_name": "Dueño Dup",
        "email": "dueno-dup@example.test",
        "password": "ClaveDup1234",
    }
    assert api.client.post("/auth/register", json=payload).status_code == 201
    res = api.client.post("/auth/register", json=payload)
    assert res.status_code == 409


def test_purge_user_requires_exact_email_confirm(api):
    venue = api.world["venue_a"]
    password = api.world["password"]
    created = api.post(
        f"/venues/{venue}/users",
        "admin",
        {
            "email": "purgable@example.test",
            "full_name": "Purgable",
            "password": password,
            "role": "promotor",
        },
    ).json()

    # Confirmación incorrecta -> 400, el usuario sigue existiendo.
    res = api.client.request(
        "DELETE",
        f"/venues/{venue}/users/{created['id']}/purge",
        headers=api.headers("admin"),
        json={"confirm": "otro@email.test"},
    )
    assert res.status_code == 400

    # Confirmación correcta -> el usuario desaparece (login 401).
    res = api.client.request(
        "DELETE",
        f"/venues/{venue}/users/{created['id']}/purge",
        headers=api.headers("admin"),
        json={"confirm": created["email"]},
    )
    assert res.status_code == 200, res.text
    login = api.client.post(
        "/auth/login",
        json={"email": created["email"], "password": password},
    )
    assert login.status_code == 401


def test_change_password_flow(api):
    payload = {
        "venue_name": "Teatro Pass",
        "full_name": "Dueño Pass",
        "email": "dueno-pass@example.test",
        "password": "ClaveVieja1",
    }
    reg = api.client.post("/auth/register", json=payload)
    assert reg.status_code == 201
    token = reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # Contraseña actual incorrecta -> 400.
    res = api.client.post(
        "/auth/change-password",
        headers=headers,
        json={"current_password": "incorrecta1", "new_password": "ClaveNueva2"},
    )
    assert res.status_code == 400

    # Misma contraseña -> 400.
    res = api.client.post(
        "/auth/change-password",
        headers=headers,
        json={"current_password": payload["password"], "new_password": payload["password"]},
    )
    assert res.status_code == 400

    # Cambio correcto -> 200, y las credenciales quedan intercambiadas.
    res = api.client.post(
        "/auth/change-password",
        headers=headers,
        json={"current_password": payload["password"], "new_password": "ClaveNueva2"},
    )
    assert res.status_code == 200, res.text
    assert (
        api.client.post(
            "/auth/login", json={"email": payload["email"], "password": payload["password"]}
        ).status_code
        == 401
    )
    assert (
        api.client.post(
            "/auth/login", json={"email": payload["email"], "password": "ClaveNueva2"}
        ).status_code
        == 200
    )


def test_update_profile_name(api):
    payload = {
        "venue_name": "Teatro Perfil",
        "full_name": "Dueño Original",
        "email": "dueno-perfil@example.test",
        "password": "ClavePerfil1",
    }
    reg = api.client.post("/auth/register", json=payload)
    headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}

    res = api.client.patch(
        "/auth/profile", headers=headers, json={"full_name": "Nombre Nuevo"}
    )
    assert res.status_code == 200, res.text
    assert res.json()["full_name"] == "Nombre Nuevo"
    # /auth/me refleja el cambio
    me = api.client.get("/auth/me", headers=headers).json()
    assert me["full_name"] == "Nombre Nuevo"

    # Muy corto -> 422
    res = api.client.patch("/auth/profile", headers=headers, json={"full_name": "A"})
    assert res.status_code == 422


def test_update_venue_name_and_logo(api):
    payload = {
        "venue_name": "Bar Original",
        "full_name": "Dueño Venue",
        "email": "dueno-venue@example.test",
        "password": "ClaveVenue1",
    }
    reg = api.client.post("/auth/register", json=payload)
    body = reg.json()
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    venue_id = body["user"]["venues"][0]["id"]

    res = api.client.patch(
        f"/auth/venues/{venue_id}",
        headers=headers,
        json={"name": "Bar Renombrado", "logo_url": "https://cdn.example.com/logo.png"},
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["name"] == "Bar Renombrado"
    assert data["logo_url"] == "https://cdn.example.com/logo.png"

    # Limpiar logo con string vacío
    res = api.client.patch(
        f"/auth/venues/{venue_id}", headers=headers, json={"logo_url": ""}
    )
    assert res.status_code == 200
    assert res.json()["logo_url"] is None

    # URL no-http -> 422
    res = api.client.patch(
        f"/auth/venues/{venue_id}", headers=headers, json={"logo_url": "javascript:alert(1)"}
    )
    assert res.status_code == 422

    # Un promotor no puede editar la venue -> 403 (creado por su dueño)
    created = api.client.post(
        f"/venues/{venue_id}/users",
        headers=headers,
        json={
            "email": "promo-venue@example.test",
            "full_name": "Promo Venue",
            "password": "ClavePromo1",
            "role": "promotor",
        },
    )
    assert created.status_code == 201, created.text
    promo_login = api.client.post(
        "/auth/login",
        json={"email": "promo-venue@example.test", "password": "ClavePromo1"},
    )
    promo_headers = {"Authorization": f"Bearer {promo_login.json()['access_token']}"}
    res = api.client.request(
        "PATCH",
        f"/auth/venues/{venue_id}",
        headers=promo_headers,
        json={"name": "Hack"},
    )
    assert res.status_code == 403


def test_delete_event_requires_name_confirm_and_draft(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Borrable")

    # Nombre incorrecto -> 400.
    res = api.client.request(
        "DELETE",
        api.event_url(venue, ev["id"]),
        headers=api.headers("admin"),
        json={"confirm": "Otro"},
    )
    assert res.status_code == 400

    # Evento publicado no se borra -> 409 (se cancela, no se borra).
    api.publish("admin", venue, ev["id"])
    res = api.client.request(
        "DELETE",
        api.event_url(venue, ev["id"]),
        headers=api.headers("admin"),
        json={"confirm": "Borrable"},
    )
    assert res.status_code == 409
