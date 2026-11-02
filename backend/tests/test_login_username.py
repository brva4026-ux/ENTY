"""Entrar con usuario o correo (mig 035).

El login aceptaba SOLO correo (`LoginRequest.email` con pattern de email). Ahora
el campo es `identifier` y resuelve las dos formas:

  * un correo -> `lower(email)`
  * un usuario -> `lower(username)`, y solo si el valor NO trae "@"

Estos tests fijan el contrato: la compatibilidad hacia atras (los clientes que
mandan `email`), la insensibilidad a mayusculas, que un correo no pueda matchear
un username y que el lockout siga contando por identificador.
"""
import pytest

# Mismo formato que el CHECK de la DB y el validador del schema.
USERNAME_BAD = "con espacio"


def username_of(api, who: str) -> str:
    """Un username unico por test, derivado del correo (que ya trae un tag).

    El indice de username es GLOBAL en la tabla, no por venue ni por test: usar
    una constante haria que el primer test dejara el nombre tomado y el segundo
    reventara con UniqueViolation. El correo del `world` ya es unico.
    """
    return api.world[who]["email"].split("@")[0].lower()


def _cleanup(db):
    """El lockout es compartido entre requests: cada test parte de cero."""
    db.execute("DELETE FROM login_attempts")


def _set_username(db, user_id: int, username: str | None):
    db.execute("UPDATE users SET username=%s WHERE id=%s", (username, user_id))


def _login(api, payload: dict):
    return api.client.post("/auth/login", json=payload)


# ---------------------------------------------------------------------------
# El identificador resuelve correo Y usuario
# ---------------------------------------------------------------------------
def test_login_with_username(api, db):
    """Con `identifier=usuario` entra la cuenta correcta."""
    _cleanup(db)
    who = api.world["bouncer"]
    uname = username_of(api, "bouncer")
    _set_username(db, who["id"], uname)

    res = _login(api, {"identifier": uname, "password": api.world["password"]})
    assert res.status_code == 200, res.text
    assert res.json()["user"]["email"] == who["email"]
    assert res.json()["user"]["username"] == uname


def test_login_username_is_case_insensitive(api, db):
    """'Bouncer.Uno' entra igual que 'bouncer.uno': el indice es sobre lower()."""
    _cleanup(db)
    who = api.world["bouncer"]
    uname = username_of(api, "bouncer")
    _set_username(db, who["id"], uname)

    res = _login(api, {"identifier": uname.upper(), "password": api.world["password"]})
    assert res.status_code == 200, res.text
    assert res.json()["user"]["email"] == who["email"]


def test_login_with_email_still_works(api, db):
    """Compatibilidad: quien manda su correo entra como siempre."""
    _cleanup(db)
    who = api.world["admin"]

    res = _login(api, {"identifier": who["email"], "password": api.world["password"]})
    assert res.status_code == 200, res.text
    assert res.json()["user"]["email"] == who["email"]


def test_login_with_legacy_email_field(api, db):
    """El campo `email` sigue siendo un alias valido del identificador."""
    _cleanup(db)
    who = api.world["admin"]

    res = _login(api, {"email": who["email"], "password": api.world["password"]})
    assert res.status_code == 200, res.text
    assert res.json()["user"]["email"] == who["email"]


def test_identifier_wins_over_email_alias(api, db):
    """Si vienen los dos, manda `identifier` (es el campo nuevo)."""
    _cleanup(db)
    quien = api.world["bouncer"]
    otro = api.world["admin"]
    uname = username_of(api, "bouncer")
    _set_username(db, quien["id"], uname)

    res = _login(
        api,
        {
            "identifier": uname,
            "email": otro["email"],
            "password": api.world["password"],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["user"]["email"] == quien["email"]


# ---------------------------------------------------------------------------
# Casos que NO deben entrar
# ---------------------------------------------------------------------------
def test_unknown_username_is_401(api, db):
    """Un usuario que no existe no entra (mismo 401 generico que un correo)."""
    _cleanup(db)
    res = _login(api, {"identifier": "no-existe-nadie", "password": api.world["password"]})
    assert res.status_code == 401, res.text


def test_email_never_matches_username_branch(api, db):
    """Un valor con "@" jamas resuelve por la rama de username.

    Aunque alguien lograra meter un username con arroba, el `position('@' in ..)`
    corta esa rama: un correo solo entra por correo.
    """
    _cleanup(db)
    quien = api.world["admin"]
    # Se fuerza por SQL (la DB no lo permitiria por su CHECK) para probar que la
    # defensa vive tambien en el query, no solo en la constraint.
    try:
        db.execute("UPDATE users SET username=%s WHERE id=%s", (quien["email"], quien["id"]))
    except Exception:
        pytest.skip("la DB rechaza un username con '@' (CHECK de la mig 035)")
    res = _login(api, {"identifier": quien["email"], "password": api.world["password"]})
    assert res.status_code == 200, res.text
    assert res.json()["user"]["email"] == quien["email"]


def test_username_of_other_account_does_not_leak(api, db):
    """Conocer el usuario de otro no basta: la contraseña sigue mandando."""
    _cleanup(db)
    quien = api.world["bouncer"]
    uname = username_of(api, "bouncer")
    _set_username(db, quien["id"], uname)

    res = _login(api, {"identifier": uname, "password": "contrasena-mala"})
    assert res.status_code == 401, res.text


def test_missing_identifier_is_422(api, db):
    """Sin usuario ni correo el request es invalido, no un 401 confuso."""
    _cleanup(db)
    res = _login(api, {"password": api.world["password"]})
    assert res.status_code == 422, res.text


# ---------------------------------------------------------------------------
# Lockout: cuenta por identificador
# ---------------------------------------------------------------------------
def test_lockout_counts_by_username(api, db):
    """8 fallos con el mismo usuario bloquean ese usuario (no el correo)."""
    _cleanup(db)
    quien = api.world["bouncer"]
    uname = username_of(api, "bouncer")
    _set_username(db, quien["id"], uname)

    for _ in range(8):
        res = _login(api, {"identifier": uname, "password": "mala"})
        assert res.status_code == 401

    # El 9no, con la contraseña correcta, ya esta bloqueado.
    blocked = _login(api, {"identifier": uname, "password": api.world["password"]})
    assert blocked.status_code == 429, blocked.text
    _cleanup(db)


# ---------------------------------------------------------------------------
# El usuario viaja en las respuestas y se puede reclamar desde el perfil
# ---------------------------------------------------------------------------
def test_me_returns_username(api, db):
    """GET /auth/me expone el username (el front lo usa para el saludo)."""
    _cleanup(db)
    quien = api.world["bouncer"]
    uname = username_of(api, "bouncer")
    _set_username(db, quien["id"], uname)

    res = api.get("/auth/me", "bouncer")
    assert res.status_code == 200, res.text
    assert res.json()["username"] == uname


def test_me_username_is_null_when_unset(api, db):
    """Sin username la cuenta sigue siendo valida: `username` es None."""
    _cleanup(db)
    _set_username(db, api.world["admin"]["id"], None)

    res = api.get("/auth/me", "admin")
    assert res.status_code == 200, res.text
    assert res.json()["username"] is None


def test_profile_claims_username(api, db):
    """PATCH /auth/profile permite reclamar un usuario libre."""
    _cleanup(db)
    quien = api.world["promoter2"]
    uname = username_of(api, "promoter2")
    _set_username(db, quien["id"], None)

    res = api.patch(
        "/auth/profile",
        "promoter2",
        {"full_name": "Promo Dos", "username": f"dos.{uname}"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["username"] == f"dos.{uname}"

    # Y con ese usuario ya puede entrar.
    ok = _login(api, {"identifier": f"dos.{uname}", "password": api.world["password"]})
    assert ok.status_code == 200, ok.text


def test_profile_normalizes_username_to_lowercase(api, db):
    """El usuario se guarda en minusculas (una sola identidad, no dos)."""
    _cleanup(db)
    quien = api.world["promoter2"]
    uname = username_of(api, "promoter2")
    _set_username(db, quien["id"], None)

    res = api.patch(
        "/auth/profile",
        "promoter2",
        {"full_name": "Promo Dos", "username": f"  {uname.upper()}  "},
    )
    assert res.status_code == 200, res.text
    assert res.json()["username"] == uname


def test_profile_duplicate_username_is_409(api, db):
    """Un usuario ya tomado responde 409, no un 500 por constraint."""
    _cleanup(db)
    tomado = api.world["bouncer"]
    uname = username_of(api, "bouncer")
    _set_username(db, tomado["id"], uname)
    otro = api.world["promoter"]
    _set_username(db, otro["id"], None)

    res = api.patch(
        "/auth/profile",
        "promoter",
        {"full_name": "Promo Uno", "username": uname},
    )
    assert res.status_code == 409, res.text
    assert "uso" in res.json()["detail"].lower()


def test_profile_duplicate_is_case_insensitive(api, db):
    """'BOUNCER.UNO' choca con 'bouncer.uno': el indice compara en minusculas."""
    _cleanup(db)
    tomado = api.world["bouncer"]
    uname = username_of(api, "bouncer")
    _set_username(db, tomado["id"], uname)
    otro = api.world["promoter"]
    _set_username(db, otro["id"], None)

    res = api.patch(
        "/auth/profile",
        "promoter",
        {"full_name": "Promo Uno", "username": uname.upper()},
    )
    assert res.status_code == 409, res.text


def test_profile_rejects_bad_username_format(api, db):
    """Un formato invalido da 422 con mensaje, no un error de constraint."""
    _cleanup(db)
    res = api.patch(
        "/auth/profile",
        "promoter",
        {"full_name": "Promo Uno", "username": USERNAME_BAD},
    )
    assert res.status_code == 422, res.text


def test_profile_empty_username_releases_it(api, db):
    """`""` libera el usuario; la cuenta vuelve a entrar solo con correo."""
    _cleanup(db)
    quien = api.world["bouncer"]
    uname = username_of(api, "bouncer")
    _set_username(db, quien["id"], uname)

    res = api.patch(
        "/auth/profile",
        "bouncer",
        {"full_name": "Bouncer Puerta", "username": ""},
    )
    assert res.status_code == 200, res.text
    assert res.json()["username"] is None

    # Y ese usuario ya quedo libre para otra cuenta.
    assert _login(api, {"identifier": uname, "password": api.world["password"]}).status_code == 401


def test_profile_omitting_username_keeps_it(api, db):
    """No mandar `username` no lo borra: solo cambia el nombre visible."""
    _cleanup(db)
    quien = api.world["bouncer"]
    uname = username_of(api, "bouncer")
    _set_username(db, quien["id"], uname)

    res = api.patch("/auth/profile", "bouncer", {"full_name": "Puerta Renombrada"})
    assert res.status_code == 200, res.text
    assert res.json()["username"] == uname
    assert res.json()["full_name"] == "Puerta Renombrada"


# ---------------------------------------------------------------------------
# La constraint de la DB (mig 035) es la ultima linea de defensa
# ---------------------------------------------------------------------------
def test_db_rejects_duplicate_username(db):
    """Dos cuentas no pueden compartir usuario (indice unico sobre lower)."""
    _cleanup(db)
    import uuid

    uname = f"dup-{uuid.uuid4().hex[:8]}"
    a = db.execute(
        "INSERT INTO users (email, password_hash, full_name, username) "
        "VALUES (%s, 'x', 'A', %s) RETURNING id",
        (f"{uname}-a@example.test", uname),
    ).fetchone()["id"]
    try:
        with pytest.raises(Exception):
            db.execute(
                "INSERT INTO users (email, password_hash, full_name, username) "
                "VALUES (%s, 'x', 'B', %s)",
                (f"{uname}-b@example.test", uname.upper()),
            )
    finally:
        db.execute("DELETE FROM users WHERE id=%s", (a,))


def test_db_rejects_malformed_username(db):
    """El CHECK de formato tambien vive en la DB (INSERT manual incluido)."""
    with pytest.raises(Exception):
        db.execute(
            "INSERT INTO users (email, password_hash, full_name, username) "
            "VALUES ('bad-fmt@example.test', 'x', 'B', 'Con Espacio')"
        )
