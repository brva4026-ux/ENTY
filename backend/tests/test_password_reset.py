"""Reset de contrasena self-service (mig 017).

El flujo completo sin email real (sin RESEND_API_KEY el mailer es no-op):
- forgot-password responde SIEMPRE lo mismo, exista o no el email.
- El token crudo nunca viaja en la respuesta ni se guarda en claro.
- reset-password canjea el token: cambia la credencial, mata el token y
  limpia el lockout del email.
- Politica de contrasenas aplica tambien aqui.
"""
import hashlib

from app.core.config import get_settings


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _last_reset_hash(db, email: str) -> str | None:
    """Hash del token mas reciente del usuario (los tests necesitan el crudo
    que el mailer se llevaria: lo reconstruimos del hash no se puede, asi que
    el test pide reset y leo el hash directamente para verificar estado)."""
    row = db.execute(
        """SELECT pr.token_hash FROM password_reset_tokens pr
           JOIN users u ON u.id = pr.user_id
           WHERE lower(u.email) = %s
           ORDER BY pr.created_at DESC LIMIT 1""",
        (email,),
    ).fetchone()
    return row["token_hash"] if row else None


def test_forgot_password_same_answer_for_unknown_and_known(api):
    """Anti-enumeracion: la respuesta no depende de la existencia del email."""
    r_unknown = api.client.post(
        "/auth/forgot-password", json={"email": "nadie@example.test"}
    )
    # Creamos un usuario real para comparar
    payload = {
        "venue_name": "Teatro Reset",
        "full_name": "Dueno Reset",
        "email": "reset-ok@example.test",
        "password": "ClaveReset1",
    }
    api.client.post("/auth/register", json=payload)
    r_known = api.client.post(
        "/auth/forgot-password", json={"email": payload["email"]}
    )
    assert r_unknown.status_code == 200
    assert r_known.status_code == 200
    assert r_unknown.json()["detail"] == r_known.json()["detail"]


def test_forgot_creates_token_row(api, db):
    payload = {
        "venue_name": "Teatro Token",
        "full_name": "Dueno Token",
        "email": "reset-token@example.test",
        "password": "ClaveToken1",
    }
    api.client.post("/auth/register", json=payload)
    api.client.post("/auth/forgot-password", json={"email": payload["email"]})

    row = db.execute(
        """SELECT pr.used_at, pr.expires_at FROM password_reset_tokens pr
           JOIN users u ON u.id = pr.user_id
           WHERE lower(u.email) = %s
           ORDER BY pr.created_at DESC LIMIT 1""",
        (payload["email"],),
    ).fetchone()
    assert row is not None
    assert row["used_at"] is None          # sin consumir
    assert row["expires_at"] is not None   # ventana de 60 min


def test_full_reset_flow_changes_credentials(api, db):
    payload = {
        "venue_name": "Teatro Flujo",
        "full_name": "Dueno Flujo",
        "email": "reset-flujo@example.test",
        "password": "ClaveVieja1",
    }
    api.client.post("/auth/register", json=payload)

    # Fallos de login previos: el reset debe limpiar el lockout del email.
    for _ in range(8):
        api.client.post(
            "/auth/login", json={"email": payload["email"], "password": "equivocada1A"}
        )

    api.client.post("/auth/forgot-password", json={"email": payload["email"]})

    # El token crudo solo existe en el correo; el test lo reproduce porque
    # en entorno de test podemos fijar determinismo: pedimos otro reset y
    # usamos el hash para recuperar el crudo es imposible, asi que exponemos
    # el token por el unico canal honesto: pedirlo y capturarlo del mailer
    # no se puede; en su lugar, el canje se prueba con el token que el
    # endpoint registra. Para el test, insertamos directamente un token
    # conocido (el flujo real email->usuario ya esta cubierto por
    # test_forgot_creates_token_row).
    raw = "token-crudo-de-test-0123456789abcdef"
    import psycopg

    with db.cursor() as cur:
        cur.execute(
            """INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
               SELECT id, %s, now() + interval '60 minutes' FROM users
               WHERE lower(email) = %s""",
            (_hash(raw), payload["email"]),
        )
    db.commit()

    # Canje con contrasena debil -> 422 (la politica aplica tambien aqui)
    r_weak = api.client.post(
        "/auth/reset-password",
        json={"token": raw, "new_password": "aaaa1234"},
    )
    assert r_weak.status_code == 422

    # Canje correcto
    r = api.client.post(
        "/auth/reset-password",
        json={"token": raw, "new_password": "ClaveNueva9"},
    )
    assert r.status_code == 200, r.text

    # El token queda consumido: segundo canje -> 400
    r2 = api.client.post(
        "/auth/reset-password",
        json={"token": raw, "new_password": "OtraNueva9x"},
    )
    assert r2.status_code == 400

    # Credenciales intercambiadas. OJO: el martillo de 8 fallos de arriba
    # sigue contando para el cubo de IP (el reset limpia el cubo del EMAIL,
    # no el de IP) — el login exitoso con la clave nueva lo limpia, pero el
    # 401 esperado de la clave vieja puede venir precedido del 429 del cubo
    # de IP. Por eso se limpia el cubo de IP antes de verificar credenciales:
    # lo que este test verifica es el CAMBIO de credenciales, no el lockout.
    db.execute("DELETE FROM login_attempts WHERE ip = 'testclient'")
    assert (
        api.client.post(
            "/auth/login", json={"email": payload["email"], "password": "ClaveVieja1"}
        ).status_code
        == 401
    )
    assert (
        api.client.post(
            "/auth/login", json={"email": payload["email"], "password": "ClaveNueva9"}
        ).status_code
        == 200
    )


def test_reset_with_garbage_token_is_generic_400(api):
    r = api.client.post(
        "/auth/reset-password",
        json={"token": "token-inexistente-xyz", "new_password": "ClaveNueva9"},
    )
    assert r.status_code == 400
    assert "no es valido" in r.json()["detail"].lower() or "expir" in r.json()["detail"].lower()
