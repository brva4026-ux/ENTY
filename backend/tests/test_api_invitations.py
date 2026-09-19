"""Tests v1.2: invitaciones de staff por enlace de un solo uso (patrón unicall-blue).

El admin genera un enlace (se muestra UNA vez), el invitado abre la página,
crea SU contraseña y entra. Cobertura:

- Permisos: solo admin/super_admin de la venue; el admin de otra venue no.
- Email de un miembro activo → 409.
- Canje: crea usuario nuevo con SU contraseña y rol correcto, sesión válida.
- Un solo uso real: el segundo canje del mismo token falla (UPDATE atómico).
- Bounce de validación: contraseña corta en el canje NO consume el token.
- Reactivación: un ex-empleado desactivado que acepta invitación vuelve a entrar.
- Revocación: el enlace revocado no sirve ni se previsualiza.
- Expiración: el enlace vencido no sirve ni se previsualiza.

Nota de diseño: la ligadura de email es estructural — el email viaja DENTRO de
la invitación (lo fijó el admin), no lo provee quien canjea. Un enlace
reenviado solo puede usarlo la persona invitada.
"""
import uuid


def _create(api, venue, email, role="promotor", full_name="Invitado QA", hours=72):
    return api.post(
        f"/auth/venues/{venue}/invitations",
        "admin",
        {"full_name": full_name, "email": email, "role": role, "expires_hours": hours},
    )


def _accept(client, token, password="ClaveInvita1"):
    return client.post(
        "/auth/invitations/accept",
        json={"token": token, "password": password},
    )


def _raw_token_from(url: str) -> str:
    from urllib.parse import parse_qs, urlparse

    return parse_qs(urlparse(url).query)["token"][0]


def _tag() -> str:
    return uuid.uuid4().hex[:8]


def test_create_requires_admin_of_venue(api):
    venue = api.world["venue_a"]

    body = {"full_name": "Xx", "email": "x@t.test", "role": "promotor"}

    # Un promotor no puede invitar.
    r = api.post(f"/auth/venues/{venue}/invitations", "promoter", body)
    assert r.status_code == 403, r.text

    # El admin de otra venue tampoco (aislamiento multi-tenant).
    r = api.post(f"/auth/venues/{venue}/invitations", "outsider", body)
    assert r.status_code == 403, r.text


def test_create_and_redeem_new_user(api):
    venue = api.world["venue_a"]
    email = f"inv_{_tag()}@t.test"

    res = _create(api, venue, email, role="bouncer", full_name="Portero Uno")
    assert res.status_code == 201, res.text
    inv = res.json()
    assert inv["invite_url"].startswith("/invitacion?token="), inv

    # El token solo viaja en la creación; en la lista NUNCA aparece el enlace.
    lst = api.get(f"/auth/venues/{venue}/invitations", "admin")
    assert lst.status_code == 200
    row = next(i for i in lst.json() if i["id"] == inv["id"])
    assert "invite_url" not in row and "token" not in row

    # Preview público con el token real: muestra negocio y rol, nada sensible.
    tok = _raw_token_from(inv["invite_url"])
    pv = api.client.get("/auth/invitations/preview", params={"token": tok})
    assert pv.status_code == 200
    assert pv.json()["role"] == "bouncer"
    assert len(pv.json()["venue_name"]) > 0

    # Canje: la persona crea SU contraseña.
    acc = _accept(api.client, tok, "MiPropiaClave1")
    assert acc.status_code == 200, acc.text
    data = acc.json()
    assert data["user"]["email"] == email

    # La sesión sirve y el rol quedó asignado en la venue.
    me = api.client.get(
        "/auth/me", headers={"Authorization": f"Bearer {data['access_token']}"}
    )
    assert me.status_code == 200
    venue_ids = [v["id"] for v in me.json()["venues"]]
    assert venue in venue_ids

    # Y la contraseña que eligió funciona en el login normal.
    login = api.client.post(
        "/auth/login", json={"email": email, "password": "MiPropiaClave1"}
    )
    assert login.status_code == 200


def test_single_use_atomic(api):
    venue = api.world["venue_a"]
    email = f"once_{_tag()}@t.test"

    res = _create(api, venue, email)
    assert res.status_code == 201
    tok = _raw_token_from(res.json()["invite_url"])

    first = _accept(api.client, tok)
    assert first.status_code == 200, first.text
    # Segundo canje del mismo enlace: rechazado.
    second = _accept(api.client, tok)
    assert second.status_code == 404
    assert "ya se usó" in second.json()["detail"]


def test_validation_bounce_does_not_consume_token(api):
    venue = api.world["venue_a"]
    res = _create(api, venue, f"bounce_{_tag()}@t.test")
    tok = _raw_token_from(res.json()["invite_url"])

    # Contraseña corta: 422 de validación ANTES de tocar la DB.
    short = _accept(api.client, tok, "corta")
    assert short.status_code == 422

    # El token sigue utilizable (nada se consumió con el bounce).
    ok = _accept(api.client, tok)
    assert ok.status_code == 200


def test_reactivates_deactivated_member(api):
    """Ex-empleado desactivado + invitación nueva = recontratado (puede entrar)."""
    venue = api.world["venue_a"]
    prom = api.world["promoter"]

    # Desactivar al promotor del escenario.
    r = api.patch(f"/venues/{venue}/users/{prom['id']}", "admin", {"is_active": False})
    assert r.status_code == 200, r.text

    # Invitar su mismo email de nuevo.
    res = _create(api, venue, prom["email"], role="promotor", full_name="Promotor Recontratado")
    assert res.status_code == 201, res.text
    tok = _raw_token_from(res.json()["invite_url"])

    acc = _accept(api.client, tok, "Reactivada12")
    assert acc.status_code == 200, acc.text

    # Puede iniciar sesión de nuevo con la contraseña que acaba de crear.
    login = api.client.post(
        "/auth/login", json={"email": prom["email"], "password": "Reactivada12"}
    )
    assert login.status_code == 200


def test_revoked_invitation_unusable(api):
    venue = api.world["venue_a"]
    res = _create(api, venue, f"rev_{_tag()}@t.test")
    inv = res.json()
    tok = _raw_token_from(inv["invite_url"])

    r = api.delete(f"/auth/venues/{venue}/invitations/{inv['id']}", "admin")
    assert r.status_code == 204

    assert api.client.get("/auth/invitations/preview", params={"token": tok}).status_code == 404
    assert _accept(api.client, tok).status_code == 404

    # Revocar de nuevo: 409 (ya revocada).
    r2 = api.delete(f"/auth/venues/{venue}/invitations/{inv['id']}", "admin")
    assert r2.status_code == 409


def test_expired_invitation_unusable(api, dbcur):
    venue = api.world["venue_a"]
    res = _create(api, venue, f"exp_{_tag()}@t.test")
    tok = _raw_token_from(res.json()["invite_url"])

    # Vencer el token directamente en la DB (única forma de probar expiración).
    import hashlib

    dbcur.execute(
        "UPDATE staff_invitations SET expires_at = now() - interval '1 hour' "
        "WHERE token_hash=%s",
        (hashlib.sha256(tok.encode()).hexdigest(),),
    )
    assert api.client.get("/auth/invitations/preview", params={"token": tok}).status_code == 404
    assert _accept(api.client, tok).status_code == 404


def test_member_of_team_cannot_be_invited(api):
    venue = api.world["venue_a"]
    r = _create(api, venue, api.world["promoter"]["email"])
    assert r.status_code == 409
    assert "ya es parte" in r.json()["detail"]


def test_lifecycle_after_accept(api):
    """Tras canjear: invitación marcada como aceptada y la persona es miembro
    con el rol correcto (visible en /users del admin)."""
    venue = api.world["venue_a"]
    email = f"lifecycle_{_tag()}@t.test"

    res = _create(api, venue, email, role="admin")
    tok = _raw_token_from(res.json()["invite_url"])
    acc = _accept(api.client, tok)
    assert acc.status_code == 200

    users = api.get(f"/venues/{venue}/users", "admin").json()
    roles = {u["email"]: u["roles"] for u in users}
    assert roles[email] == ["admin"]
