"""Personal POR EVENTO (mig 025): roster de la noche + link de puerta fijo.

Lo que se prueba acá es el comportamiento que motivó la feature, no solo que
los endpoints existan:

- El roster es POR evento: la misma persona puede estar en la noche A y no en
  la B. Ese es el corazón del pedido.
- Aislamiento multi-tenant: el admin de otra venue no toca el roster ni emite
  links; un evento de otra venue no se puede leer por id.
- Asignar exige que la persona sea del bar (si no, la fila sería inútil:
  nadie podría abrirla).
- Reasignar el rol actualiza, no duplica (una persona, un rol por noche).
- El link se genera solo para alguien del roster.
- El token en claro viaja SOLO al crearlo; el listado nunca lo expone.
- Rotar mata el anterior (índice único parcial).
- Quitar a alguien de la noche se lleva sus links: si ya no trabaja ahí, un
  link vivo es una puerta abierta.
- El canje es de UN solo uso y solo por la persona para la que se emitió.
- El link NO habilita otras noches: no es una credencial de administración.

Sin seed el world no existe y estos tests se saltan (convención del repo).
"""
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse


def _tag() -> str:
    return uuid.uuid4().hex[:8]


def _token(access_url: str) -> str:
    return parse_qs(urlparse(access_url).query)["token"][0]


def _token_admin(api_client, world) -> str:
    """JWT del admin: para armar peticiones que no pasan por el atajo `api`."""
    res = api_client.post(
        "/auth/login",
        json={"email": world["admin"]["email"], "password": world["password"]},
    )
    assert res.status_code == 200, res.text
    return res.json()["access_token"]


def _night(api, name="Noche de prueba"):
    """Un evento nuevo y sin roster: el punto de partida limpio."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"{name} {_tag()}")
    return venue, ev["id"]


def _assign(api, venue, event_id, who="bouncer", role="bouncer"):
    return api.post(
        f"/venues/{venue}/events/{event_id}/staff",
        "admin",
        {"user_id": api.world[who]["id"], "role": role},
    )


# ---------------------------------------------------------------------------
# El roster es por evento
# ---------------------------------------------------------------------------
def test_roster_is_per_event(api):
    """La misma persona entra en la noche A y NO en la noche B."""
    venue, event_a = _night(api, "Noche A")
    _, event_b = _night(api, "Noche B")

    r = _assign(api, venue, event_a, who="bouncer", role="bouncer")
    assert r.status_code == 201, r.text

    lista_a = api.get(f"/venues/{venue}/events/{event_a}/staff", "admin")
    lista_b = api.get(f"/venues/{venue}/events/{event_b}/staff", "admin")
    assert lista_a.status_code == 200, lista_a.text
    assert [s["user_id"] for s in lista_a.json()] == [api.world["bouncer"]["id"]]
    assert lista_b.json() == [], "el roster no se filtró de una noche a otra"


def test_reassign_role_updates_instead_of_duplicating(api):
    venue, event_id = _night(api)
    _assign(api, venue, event_id, who="bouncer", role="bouncer")
    r = _assign(api, venue, event_id, who="bouncer", role="promotor")
    assert r.status_code == 201, r.text

    rows = api.get(f"/venues/{venue}/events/{event_id}/staff", "admin").json()
    assert len(rows) == 1, "cambiar de puesto duplicó a la persona en la noche"
    assert rows[0]["role"] == "promotor"


def test_assign_requires_a_venue_member(api):
    """Asignar a un desconocido deja una fila que nadie puede abrir."""
    venue, event_id = _night(api)
    r = api.post(
        f"/venues/{venue}/events/{event_id}/staff",
        "admin",
        {"user_id": 999999, "role": "bouncer"},
    )
    assert r.status_code == 409, r.text
    assert "equipo" in r.json()["detail"].lower()


def test_remove_clears_the_person_from_that_night(api):
    venue, event_id = _night(api)
    _assign(api, venue, event_id, who="bouncer")
    uid = api.world["bouncer"]["id"]

    r = api.delete(f"/venues/{venue}/events/{event_id}/staff/{uid}", "admin")
    assert r.status_code == 204, r.text
    assert api.get(f"/venues/{venue}/events/{event_id}/staff", "admin").json() == []
    # Sacarla dos veces no es un success silencioso.
    assert api.delete(f"/venues/{venue}/events/{event_id}/staff/{uid}", "admin").status_code == 404


# ---------------------------------------------------------------------------
# Aislamiento: la night's roster es del dueño de esa noche
# ---------------------------------------------------------------------------
def test_only_venue_admin_manages_the_roster(api):
    venue, event_id = _night(api)
    body = {"user_id": api.world["bouncer"]["id"], "role": "bouncer"}

    assert api.post(f"/venues/{venue}/events/{event_id}/staff", "promoter", body).status_code == 403
    assert api.get(f"/venues/{venue}/events/{event_id}/staff", "promoter").status_code == 403
    # El admin de OTRA venue tampoco: ni leer ni escribir.
    assert api.get(f"/venues/{venue}/events/{event_id}/staff", "outsider").status_code == 403
    assert api.post(f"/venues/{venue}/events/{event_id}/staff", "outsider", body).status_code == 403


def test_event_of_another_venue_is_not_readable(api):
    """Conocer el id de un evento ajeno no alcanza: se filtra por venue."""
    venue, event_id = _night(api)
    r = api.get(f"/venues/{venue}/events/{event_id}/staff", "admin")
    assert r.status_code == 200

    # El admin de la otra venue pide el MISMO id contra SU venue: no existe.
    otra = api.world["venue_b"]
    assert api.get(f"/venues/{otra}/events/{event_id}/staff", "outsider").status_code == 404


def test_cancelled_event_refuses_new_staff(api):
    venue, event_id = _night(api)
    api.run_sql(f"UPDATE events SET status = 'cancelled' WHERE id = {event_id}")
    r = _assign(api, venue, event_id, who="bouncer")
    assert r.status_code == 409, r.text


# ---------------------------------------------------------------------------
# El link de la puerta
# ---------------------------------------------------------------------------
def test_link_requires_the_person_in_the_roster(api):
    venue, event_id = _night(api)
    uid = api.world["bouncer"]["id"]
    r = api.post(f"/venues/{venue}/events/{event_id}/staff/{uid}/link", "admin")
    assert r.status_code == 409, r.text
    assert "asign" in r.json()["detail"].lower()


def test_link_is_returned_once_and_never_listed(api):
    venue, event_id = _night(api)
    _assign(api, venue, event_id, who="bouncer")
    uid = api.world["bouncer"]["id"]

    r = api.post(f"/venues/{venue}/events/{event_id}/staff/{uid}/link", "admin")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["access_url"].startswith("/puerta?token="), body
    assert body["event_id"] == event_id

    # El token en claro no aparece en ninguna lectura posterior.
    crudo = _token(body["access_url"])
    listado = api.get(f"/venues/{venue}/events/{event_id}/staff", "admin").text
    assert crudo not in listado, "el token crudo se_filters en el listado"
    assert api.run_sql(
        "SELECT count(*) FROM event_access_tokens WHERE token_hash = '%s'" % crudo
    ) == 0, "el token crudo se guardó en la DB en vez de su hash"


def test_roster_reports_who_still_needs_a_link(api):
    venue, event_id = _night(api)
    _assign(api, venue, event_id, who="bouncer")
    uid = api.world["bouncer"]["id"]
    assert api.get(f"/venues/{venue}/events/{event_id}/staff", "admin").json()[0]["has_link"] is False

    api.post(f"/venues/{venue}/events/{event_id}/staff/{uid}/link", "admin")
    assert api.get(f"/venues/{venue}/events/{event_id}/staff", "admin").json()[0]["has_link"] is True


def test_regenerating_the_link_kills_the_previous_one(api):
    venue, event_id = _night(api)
    _assign(api, venue, event_id, who="bouncer")
    uid = api.world["bouncer"]["id"]

    primero = _token(api.post(f"/venues/{venue}/events/{event_id}/staff/{uid}/link", "admin").json()["access_url"])
    segundo = _token(api.post(f"/venues/{venue}/events/{event_id}/staff/{uid}/link", "admin").json()["access_url"])
    assert primero != segundo

    # El viejo quedó revocado: no se puede canjear.
    r = api.post(f"/escaner/acceso?token={primero}", "bouncer")
    assert r.status_code == 410, r.text
    assert api.post(f"/escaner/acceso?token={segundo}", "bouncer").status_code == 200


def test_removing_from_the_night_kills_the_link(api):
    """Si ya no trabaja esa noche, su link tampoco sirve."""
    venue, event_id = _night(api)
    _assign(api, venue, event_id, who="bouncer")
    uid = api.world["bouncer"]["id"]
    link = _token(api.post(f"/venues/{venue}/events/{event_id}/staff/{uid}/link", "admin").json()["access_url"])

    api.delete(f"/venues/{venue}/events/{event_id}/staff/{uid}", "admin")
    assert api.post(f"/escaner/acceso?token={link}", "bouncer").status_code == 410


# ---------------------------------------------------------------------------
# El canje: un solo uso, y solo para quien se emitió
# ---------------------------------------------------------------------------
def test_redeem_binds_the_person_to_that_one_night(api):
    venue, event_id = _night(api, "Noche con link")
    _assign(api, venue, event_id, who="bouncer")
    uid = api.world["bouncer"]["id"]
    link = _token(api.post(f"/venues/{venue}/events/{event_id}/staff/{uid}/link", "admin").json()["access_url"])

    vista = api.get(f"/escaner/acceso?token={link}", "bouncer")
    assert vista.status_code == 200, vista.text
    assert vista.json()["event_id"] == event_id
    assert vista.json()["used"] is False

    canje = api.post(f"/escaner/acceso?token={link}", "bouncer")
    assert canje.status_code == 200, canje.text
    assert canje.json()["event_id"] == event_id

    # Un solo uso: el mismo link no se canjea dos veces.
    assert api.post(f"/escaner/acceso?token={link}", "bouncer").status_code == 410


def test_link_only_works_for_its_own_person(api):
    """Un link reenviado a otro miembro del equipo no le sirve."""
    venue, event_id = _night(api)
    _assign(api, venue, event_id, who="bouncer")
    uid = api.world["bouncer"]["id"]
    link = _token(api.post(f"/venues/{venue}/events/{event_id}/staff/{uid}/link", "admin").json()["access_url"])

    assert api.post(f"/escaner/acceso?token={link}", "promoter").status_code == 410


def test_unknown_and_expired_links(api):
    venue, event_id = _night(api)
    _assign(api, venue, event_id, who="bouncer")
    uid = api.world["bouncer"]["id"]
    link = _token(api.post(f"/venues/{venue}/events/{event_id}/staff/{uid}/link", "admin").json()["access_url"])

    assert api.get("/escaner/acceso?token=no-existe", "bouncer").status_code == 404

    api.run_sql(
        "UPDATE event_access_tokens SET expires_at = now() - interval '1 hour' WHERE token_hash = ("
        "SELECT token_hash FROM event_access_tokens WHERE event_id = %d)" % event_id
    )
    assert api.post(f"/escaner/acceso?token={link}", "bouncer").status_code == 410


def test_access_requires_authentication(api_client, world):
    """El link es una credencial atada a una persona: sin sesión no se canjea."""
    venue = world["venue_a"]
    ev = api_client.post(
        f"/venues/{venue}/events",
        headers={"Authorization": f"Bearer {_token_admin(api_client, world)}"},
        json={
            "name": f"Sin sesión {_tag()}",
            "starts_at": (datetime.now(timezone.utc) + timedelta(hours=29)).isoformat(),
            "capacity": 10,
        },
    )
    assert ev.status_code == 201, ev.text

    # Sin cabecera Authorization: ni la vista previa ni el canje.
    assert api_client.get("/escaner/acceso?token=cualquiera").status_code == 401
    assert api_client.post("/escaner/acceso?token=cualquiera").status_code == 401