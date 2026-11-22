"""Tests de registro self-service y de las guardas de confirmación.

- POST /auth/register crea venue + admin y devuelve sesión válida.
- Email duplicado se rechaza (409).
- DELETE .../users/{id}/purge exige confirmar el email exacto.
- DELETE .../events/{id} exige confirmar el nombre exacto y solo borra
  en draft/cancelled.
"""

# PNG 1x1 real (mismo que test_media): para el logo del venue.
_PNG_1PX = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def test_register_creates_venue_and_admin(api):
    payload = {
        "venue_name": "Teatro Registro",
        "full_name": "Dueño Registro",
        "email": "dueno-registro@example.test",
        "password": "ClaveRegistro1",
        "accepted_terms": True,
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


def test_register_generates_username_from_venue_name(api):
    """La cuenta nace con un usuario propio (no el correo) y sirve para entrar."""
    payload = {
        "venue_name": "Casa Azul Registro",
        "full_name": "Dueña Azul",
        "email": "duena-azul@example.test",
        "password": "ClaveAzul1234",
        "accepted_terms": True,
    }
    res = api.client.post("/auth/register", json=payload)
    assert res.status_code == 201, res.text
    username = res.json()["user"]["username"]
    assert username == "casa.azul.registro"
    assert username != payload["email"].split("@")[0]

    login = api.client.post(
        "/auth/login",
        json={"identifier": username, "password": payload["password"]},
    )
    assert login.status_code == 200, login.text


def test_register_without_venue_uses_placeholder_workspace(api):
    """Sin negocio el espacio es interno y el usuario sale del nombre personal."""
    payload = {
        "full_name": "Persona Sin Negocio",
        "email": "persona-sin-negocio@example.test",
        "password": "ClavePersona1234",
        "accepted_terms": True,
    }
    res = api.client.post("/auth/register", json=payload)
    assert res.status_code == 201, res.text
    body = res.json()
    venue = body["user"]["venues"][0]
    assert venue["name"] == "Mi organización"
    assert venue["is_placeholder"] is True
    assert body["user"]["username"] == "persona.sin.negocio"

    # Configurar el nombre del negocio lo saca del estado interno.
    venue_id = venue["id"]
    updated = api.client.patch(
        f"/auth/venues/{venue_id}",
        headers={"Authorization": f"Bearer {body['access_token']}"},
        json={"name": "Negocio Real"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "Negocio Real"
    assert updated.json()["is_placeholder"] is False


def test_register_duplicate_email_conflict(api):
    payload = {
        "venue_name": "Teatro Dup",
        "full_name": "Dueño Dup",
        "email": "dueno-dup@example.test",
        "password": "ClaveDup1234",
        "accepted_terms": True,
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
        "accepted_terms": True,
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


def test_profile_exposes_account_context(api):
    """El perfil necesita contexto de cuenta: desde cuándo es miembro y cuándo
    entró por última vez. Ambos se exponen en /auth/me y en el login."""
    payload = {
        "venue_name": "Teatro Contexto",
        "full_name": "Dueño Contexto",
        "email": "dueno-contexto@example.test",
        "password": "ClaveContexto1",
        "accepted_terms": True,
    }
    reg = api.client.post("/auth/register", json=payload)
    assert reg.status_code == 201, reg.text
    created = reg.json()["user"]
    assert created["created_at"], "el registro debe exponer created_at"

    headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}
    me = api.client.get("/auth/me", headers=headers).json()
    assert me["created_at"] == created["created_at"]
    # El registro deja last_login_at NULL: aún no hubo un login explícito.
    assert me["last_login_at"] is None

    login = api.client.post(
        "/auth/login",
        json={"email": payload["email"], "password": payload["password"]},
    )
    assert login.status_code == 200, login.text
    logged = login.json()["user"]
    # Tras un login real, last_login_at queda registrado y es >= created_at.
    assert logged["last_login_at"] is not None
    assert logged["last_login_at"] >= logged["created_at"]


def test_update_profile_name(api):
    payload = {
        "venue_name": "Teatro Perfil",
        "full_name": "Dueño Original",
        "email": "dueno-perfil@example.test",
        "password": "ClavePerfil1",
        "accepted_terms": True,
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
        "accepted_terms": True,
    }
    reg = api.client.post("/auth/register", json=payload)
    body = reg.json()
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    venue_id = body["user"]["venues"][0]["id"]

    # El logo viaja como imagen subida (/media/{id}, mig 018): la guardia
    # SSRF rechaza 127.0.0.1 (y en CI sin red no hay host externo posible).
    media = api.client.post(
        f"/venues/{venue_id}/media",
        headers=headers,
        json={"data_url": _PNG_1PX},
    )
    assert media.status_code == 201, media.text
    logo = media.json()["url"]

    res = api.client.patch(
        f"/auth/venues/{venue_id}",
        headers=headers,
        json={"name": "Bar Renombrado", "logo_url": logo},
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["name"] == "Bar Renombrado"
    assert data["logo_url"] == logo

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

    # Color de marca: se guarda normalizado a minúsculas y vuelve en /auth/me.
    res = api.client.patch(
        f"/auth/venues/{venue_id}", headers=headers, json={"primary_color": "#E11D48"}
    )
    assert res.status_code == 200, res.text
    assert res.json()["primary_color"] == "#e11d48"
    me = api.client.get("/auth/me", headers=headers).json()
    venue_me = next(v for v in me["venues"] if v["id"] == venue_id)
    assert venue_me["primary_color"] == "#e11d48"

    # "" limpia el color propio: vuelve al de la marca.
    res = api.client.patch(
        f"/auth/venues/{venue_id}", headers=headers, json={"primary_color": ""}
    )
    assert res.status_code == 200, res.text
    assert res.json()["primary_color"] is None

    # Lista blanca estricta: el valor termina en un `style` del frontend, así
    # que cualquier cosa que no sea #RRGGBB se rechaza en el borde.
    for malo in ("red", "#abc", "#12345g", "url(x)", "red;background:url(x)"):
        res = api.client.patch(
            f"/auth/venues/{venue_id}", headers=headers, json={"primary_color": malo}
        )
        assert res.status_code == 422, f"{malo!r} debería ser 422, fue {res.status_code}"

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


def _event_ids(api, venue_id, who) -> list[int]:
    """Ids de los eventos de la venue (no hay GET de un evento suelto)."""
    res = api.get(f"/venues/{venue_id}/events", who)
    assert res.status_code == 200, res.text
    return [e["id"] for e in res.json()]


def test_delete_event_requires_exact_name_and_works_when_published(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Borrable")

    # Nombre incorrecto -> 400; el evento sigue existiendo.
    res = api.client.request(
        "DELETE",
        api.event_url(venue, ev["id"]),
        headers=api.headers("admin"),
        json={"confirm": "Otro"},
    )
    assert res.status_code == 400
    assert _event_ids(api, venue, "admin").count(ev["id"]) == 1

    # Publicado: ahora SI se borra (limpieza del catalogo del dueno).
    api.publish("admin", venue, ev["id"])
    res = api.client.request(
        "DELETE",
        api.event_url(venue, ev["id"]),
        headers=api.headers("admin"),
        json={"confirm": "Borrable"},
    )
    assert res.status_code == 200, res.text
    assert _event_ids(api, venue, "admin").count(ev["id"]) == 0


def test_delete_event_is_blocked_only_while_live(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="EnVivo")
    api.publish("admin", venue, ev["id"])
    live = api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    assert live.status_code == 200, live.text

    res = api.client.request(
        "DELETE",
        api.event_url(venue, ev["id"]),
        headers=api.headers("admin"),
        json={"confirm": "EnVivo"},
    )
    assert res.status_code == 409
    assert _event_ids(api, venue, "admin").count(ev["id"]) == 1


def test_delete_event_removes_its_payments(api):
    """ticket_payments NO tiene ON DELETE CASCADE: el router debe limpiarlo
    o el FK aborta el borrado de un evento que vendio con pasarela."""
    scen = api.scenario()
    venue, ev_id, type_id = scen["venue"], scen["event"], scen["type"]
    api.run_sql(
        "INSERT INTO ticket_payments "
        "(venue_id, event_id, ticket_type_id, reference, amount_in_cents, "
        " customer_name, customer_phone) VALUES "
        f"({venue}, {ev_id}, {type_id}, 'TF-{ev_id}-t', 5000, "
        "'Asistente', '3001234567')"
    )
    assert (
        api.run_sql(
            f"SELECT count(*)::int FROM ticket_payments WHERE event_id={ev_id}"
        )
        == 1
    )

    res = api.client.request(
        "DELETE",
        api.event_url(venue, ev_id),
        headers=api.headers("admin"),
        json={"confirm": "Evento de prueba"},
    )
    assert res.status_code == 200, res.text
    assert (
        api.run_sql(
            f"SELECT count(*)::int FROM ticket_payments WHERE event_id={ev_id}"
        )
        == 0
    )


# ---------------------------------------------------------------------------
# Usuario generado, colisiones y primera entrada
# ---------------------------------------------------------------------------
def _register_payload(email: str, **extra) -> dict:
    return {
        "full_name": "Persona de Prueba",
        "email": email,
        "password": "ClaveSegura123",
        "accepted_terms": True,
        **extra,
    }


def test_register_normalizes_accents_in_generated_username(api):
    """La base sale del nombre, sin tildes ni mayúsculas."""
    import uuid

    tag = uuid.uuid4().hex[:8]
    payload = _register_payload(
        f"acentos-{tag}@example.test", full_name=f"Jesús Núñez {tag}"
    )
    res = api.client.post("/auth/register", json=payload)
    assert res.status_code == 201, res.text
    assert res.json()["user"]["username"] == f"jesus.nunez.{tag}"


def test_register_uses_neutral_username_when_name_has_no_valid_base(api):
    """Un nombre sin letras ni números no produce un usuario vacío."""
    import uuid

    tag = uuid.uuid4().hex[:8]
    payload = _register_payload(f"neutro-{tag}@example.test", full_name="!!")
    res = api.client.post("/auth/register", json=payload)
    assert res.status_code == 201, res.text
    username = res.json()["user"]["username"]
    assert username == "usuario" or username.startswith("usuario-")


def test_register_resolves_sequential_username_collision(api):
    """Dos altas con el mismo nombre de negocio no comparten usuario."""
    import uuid

    tag = uuid.uuid4().hex[:8]
    name = f"Colisión {tag}"
    first = api.client.post(
        "/auth/register",
        json=_register_payload(f"colision-a-{tag}@example.test", venue_name=name),
    )
    second = api.client.post(
        "/auth/register",
        json=_register_payload(f"colision-b-{tag}@example.test", venue_name=name),
    )
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text

    u1 = first.json()["user"]["username"]
    u2 = second.json()["user"]["username"]
    assert u1 != u2
    assert u2 == f"{u1}-2"

    # Ambos usuarios entran con su propio nombre.
    password = "ClaveSegura123"
    assert (
        api.client.post(
            "/auth/login", json={"identifier": u1, "password": password}
        ).status_code
        == 200
    )
    assert (
        api.client.post(
            "/auth/login", json={"identifier": u2, "password": password}
        ).status_code
        == 200
    )


def test_register_resolves_simultaneous_username_collision(api):
    """Dos altas a la vez con la misma base: una gana, la otra reintenta."""
    import threading
    import uuid
    from concurrent.futures import ThreadPoolExecutor

    from fastapi.testclient import TestClient

    tag = uuid.uuid4().hex[:8]
    name = f"Simultánea {tag}"
    payloads = [
        _register_payload(f"simultanea-a-{tag}@example.test", venue_name=name),
        _register_payload(f"simultanea-b-{tag}@example.test", venue_name=name),
    ]
    barrier = threading.Barrier(2)
    clients = [
        api.client,
        TestClient(api.client.app, base_url="http://testserver"),
    ]
    clients[1].headers.update({"x-real-ip": "testclient"})

    def go(index: int):
        barrier.wait()
        return clients[index].post("/auth/register", json=payloads[index])

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(go, range(2)))

    assert [r.status_code for r in responses] == [201, 201], [r.text for r in responses]
    usernames = {r.json()["user"]["username"] for r in responses}
    assert len(usernames) == 2, usernames

    # La cuenta perdedora no quedó a medias: entra con su variante.
    for res in responses:
        username = res.json()["user"]["username"]
        login = api.client.post(
            "/auth/login",
            json={"identifier": username, "password": "ClaveSegura123"},
        )
        assert login.status_code == 200, login.text


def test_changing_username_invalidates_the_old_one(api):
    """El usuario anterior deja de entrar; el nuevo y el correo sí."""
    import uuid

    tag = uuid.uuid4().hex[:8]
    reg = api.client.post(
        "/auth/register",
        json=_register_payload(f"cambio-{tag}@example.test"),
    )
    assert reg.status_code == 201, reg.text
    body = reg.json()
    old = body["user"]["username"]
    new = f"nuevo.{old}"
    headers = {"Authorization": f"Bearer {body['access_token']}"}

    res = api.client.patch(
        "/auth/profile",
        headers=headers,
        json={"full_name": "Persona de Prueba", "username": new},
    )
    assert res.status_code == 200, res.text
    assert res.json()["username"] == new

    password = "ClaveSegura123"
    assert (
        api.client.post(
            "/auth/login", json={"identifier": old, "password": password}
        ).status_code
        == 401
    )
    assert (
        api.client.post(
            "/auth/login", json={"identifier": new, "password": password}
        ).status_code
        == 200
    )
    assert (
        api.client.post(
            "/auth/login", json={"identifier": payload_email(body), "password": password}
        ).status_code
        == 200
    )


def payload_email(body: dict) -> str:
    return body["user"]["email"]


def test_welcome_seen_is_persisted_once(api):
    """La bienvenida de primera entrada se marca en el servidor."""
    import uuid

    tag = uuid.uuid4().hex[:8]
    reg = api.client.post(
        "/auth/register",
        json=_register_payload(f"bienvenida-{tag}@example.test"),
    )
    assert reg.status_code == 201, reg.text
    body = reg.json()
    assert body["user"]["welcome_seen_at"] is None

    headers = {"Authorization": f"Bearer {body['access_token']}"}
    marked = api.client.post("/auth/welcome-seen", headers=headers)
    assert marked.status_code == 200, marked.text
    assert marked.json()["welcome_seen_at"] is not None

    me = api.client.get("/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["welcome_seen_at"] == marked.json()["welcome_seen_at"]
