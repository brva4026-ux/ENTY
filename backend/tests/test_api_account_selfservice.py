"""Auto-gestión de la cuenta: exportar datos, cerrar sesiones, borrarse.

Estos endpoints son la cara "de confianza" del perfil: el usuario puede
llevarse sus datos, expulsar a quien haya entrado y desaparecer por completo.
Los tres tocan seguridad, así que se prueban las puertas (contraseña,
confirmación) además del camino feliz.
"""


# ---------------------------------------------------------------------------
# Exportación de datos
# ---------------------------------------------------------------------------
def test_export_incluye_perfil_y_membresias(api, world):
    res = api.get("/auth/export", "admin")
    assert res.status_code == 200, res.text
    data = res.json()

    assert data["format_version"] == 1
    assert data["account"]["email"] == world["admin"]["email"]
    assert data["account"]["full_name"] == "Usuario admin"

    venue_ids = {m["venue_id"] for m in data["memberships"]}
    assert world["venue_a"] in venue_ids
    # Aislamiento: el admin de la venue A no ve la venue B.
    assert world["venue_b"] not in venue_ids
    assert all(m["role"] for m in data["memberships"])


def test_export_nunca_expone_el_hash_de_password(api):
    data = api.get("/auth/export", "promoter").json()
    serialized = str(data).lower()
    assert "password" not in serialized
    assert "hash" not in serialized
    assert "$2b$" not in serialized  # prefijo bcrypt: jamás debe viajar


def test_export_exige_sesion(api_client):
    assert api_client.get("/auth/export").status_code == 401


# ---------------------------------------------------------------------------
# Cierre de las demás sesiones
# ---------------------------------------------------------------------------
def test_cerrar_sesiones_con_password_incorrecta_no_hace_nada(api):
    token_viejo = api.token("promoter")
    res = api.post(
        "/auth/close-other-sessions", "promoter", {"password": "no-es-la-clave"}
    )
    assert res.status_code == 400
    # El token original sigue vivo: un intento fallido no expulsa a nadie.
    me = api.client.get(
        "/auth/me", headers={"Authorization": f"Bearer {token_viejo}"}
    )
    assert me.status_code == 200


def test_cerrar_sesiones_invalida_los_previos_y_salva_el_actual(api):
    password = api.world["password"]
    token_viejo = api.token("promoter")

    res = api.post(
        "/auth/close-other-sessions", "promoter", {"password": password}
    )
    assert res.status_code == 200, res.text
    token_nuevo = res.json()["access_token"]
    assert token_nuevo != token_viejo
    assert res.json()["user"]["email"]

    # El token viejo murió (bump de token_version)...
    viejo = api.client.get(
        "/auth/me", headers={"Authorization": f"Bearer {token_viejo}"}
    )
    assert viejo.status_code == 401
    # ...y el nuevo que devolvimos mantiene esta sesión trabajando.
    nuevo = api.client.get(
        "/auth/me", headers={"Authorization": f"Bearer {token_nuevo}"}
    )
    assert nuevo.status_code == 200


# ---------------------------------------------------------------------------
# Borrado de la propia cuenta
# ---------------------------------------------------------------------------
def test_borrar_cuenta_exige_email_exacto(api):
    res = api.client.request(
        "DELETE",
        "/auth/account",
        headers=api.headers("promoter"),
        json={
            "password": api.world["password"],
            "confirm": "otro@correo.test",
        },
    )
    assert res.status_code == 400
    # Sigue existiendo: la confirmación equivocada no borra nada.
    assert api.get("/auth/me", "promoter").status_code == 200


def test_borrar_cuenta_exige_password_correcta(api, world):
    res = api.client.request(
        "DELETE",
        "/auth/account",
        headers=api.headers("promoter"),
        json={"password": "incorrecta", "confirm": world["promoter"]["email"]},
    )
    assert res.status_code == 401
    assert api.get("/auth/me", "promoter").status_code == 200


def test_borrar_cuenta_la_elimina_de_verdad(api, world):
    email = world["promoter"]["email"]
    password = world["password"]
    res = api.client.request(
        "DELETE",
        "/auth/account",
        headers=api.headers("promoter"),
        json={"password": password, "confirm": email},
    )
    assert res.status_code == 200, res.text

    # El token ya no sirve y las credenciales tampoco.
    assert api.get("/auth/me", "promoter").status_code == 401
    login = api.client.post(
        "/auth/login", json={"email": email, "password": password}
    )
    assert login.status_code == 401


def test_admin_unico_con_equipo_no_puede_borrarse(api, world):
    """La guarda que protege al negocio de quedar acéfalo sigue en pie:
    el arreglo de arriba solo exime a quien no es admin."""
    res = api.client.request(
        "DELETE",
        "/auth/account",
        headers=api.headers("admin"),
        json={"password": world["password"], "confirm": world["admin"]["email"]},
    )
    assert res.status_code == 409
    assert api.get("/auth/me", "admin").status_code == 200
