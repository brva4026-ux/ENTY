"""Negocio activo del staff (mig 040).

Ley de Tesler (T7): la elección "con qué negocio abren mis paneles" es de la
PERSONA, no del navegador. Antes vivía solo en localStorage (`tf_venue`): el
mismo admin elegía su bar en la laptop y, al entrar desde el celular, los
paneles abrían con otro. Ahora vive en `users.active_venue_id` y viaja en el
resumen de usuario (`/auth/me`), así que sobrevive a cambiar de dispositivo.
"""


def _set_active(api, who: str, venue_id: int):
    return api.client.put(
        "/auth/me/active-venue",
        headers=api.headers(who),
        json={"venue_id": venue_id},
    )


def test_me_expone_el_negocio_activo_nulo_por_defecto(api, world):
    """Sin elección, `active_venue_id` es None: el frontend cae al primero."""
    body = api.get("/auth/me", "admin").json()
    assert body["active_venue_id"] is None


def test_guardar_negocio_activo_lo_persiste(api, world):
    """La elección se guarda y vuelve en `/auth/me` (sobrevive al navegador)."""
    res = _set_active(api, "admin", world["venue_a"])
    assert res.status_code == 200, res.text
    assert res.json()["active_venue_id"] == world["venue_a"]

    body = api.get("/auth/me", "admin").json()
    assert body["active_venue_id"] == world["venue_a"]


def test_negocio_activo_es_de_la_persona_no_de_otro(api, world):
    """Cada usuario guarda el suyo: el de un admin no cambia el de otro."""
    _set_active(api, "admin", world["venue_a"])
    _set_active(api, "promoter", world["venue_a"])

    # El promotor solo pertenece a venue_a, pero eso no debe arrastrar al admin.
    assert api.get("/auth/me", "admin").json()["active_venue_id"] == world["venue_a"]
    assert api.get("/auth/me", "promoter").json()["active_venue_id"] == world["venue_a"]


def test_negocio_activo_de_venue_ajena_es_403(api, world):
    """No se puede escribir un negocio en el que no se tiene rol: sería un
    id fantasma que haría 403 cada panel."""
    res = _set_active(api, "admin", world["venue_b"])
    assert res.status_code == 403, res.text
    # Y no quedó escrito.
    assert api.get("/auth/me", "admin").json()["active_venue_id"] is None


def test_negocio_activo_exige_sesion(api_client, world):
    res = api_client.put(
        "/auth/me/active-venue", json={"venue_id": world["venue_a"]}
    )
    assert res.status_code == 401


def test_borrar_el_negocio_activo_no_deja_id_fantasma(api, world, db):
    """ON DELETE SET NULL (mig 040): si borran el negocio, el usuario vuelve al
    default en vez de apuntar a un id muerto."""
    _set_active(api, "admin", world["venue_a"])
    assert api.get("/auth/me", "admin").json()["active_venue_id"] == world["venue_a"]

    db.execute("DELETE FROM venues WHERE id = %s", (world["venue_a"],))
    assert api.get("/auth/me", "admin").json()["active_venue_id"] is None
