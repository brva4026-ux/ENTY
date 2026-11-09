"""Preferencias del usuario por negocio (mig 032).

La guía de primeros pasos dejó de vivir en `localStorage` (por navegador) y
pasó al servidor (por usuario + venue). Lo que se prueba aquí es esa promesa:
la decisión es de la persona y sobrevive a cambiar de dispositivo.

Los endpoints son de "mis" preferencias: el `user_id` sale del token, nunca
del cuerpo, así que nadie puede leer ni escribir las de otro.
"""


# ---------------------------------------------------------------------------
# Lectura
# ---------------------------------------------------------------------------
def test_preferences_sin_filas_devuelve_las_claves_en_pending(api, world):
    """Sin fila, la clave existe en `pending`.

    El panel no distingue "no existe" de "sin decidir": para el usuario son lo
    mismo, y evita que el front tenga que saber qué claves conoce el backend."""
    res = api.get(f"/auth/me/preferences?venue_id={world['venue_a']}", "admin")
    assert res.status_code == 200, res.text
    data = res.json()

    assert data["venue_id"] == world["venue_a"]
    valores = {p["key"]: p["value"] for p in data["preferences"]}
    assert valores == {"onboarding": "pending", "tutorial": "pending"}
    # `step` es 0, no None: el front lo usa como índice sin defensa extra.
    assert all(p["step"] == 0 for p in data["preferences"])


def test_preferences_exige_sesion(api_client, world):
    res = api_client.get(f"/auth/me/preferences?venue_id={world['venue_a']}")
    assert res.status_code == 401


def test_preferences_de_venue_ajena_es_403(api, world):
    """Aislamiento multi-tenant: un admin de la venue B no lee las de la A."""
    res = api.get(f"/auth/me/preferences?venue_id={world['venue_a']}", "outsider")
    assert res.status_code == 403


# ---------------------------------------------------------------------------
# Escritura
# ---------------------------------------------------------------------------
def test_guardar_preferencia_la_devuelve_en_la_lectura(api, world):
    venue = world["venue_a"]
    res = api.client.put(
        f"/auth/me/preferences/onboarding?venue_id={venue}",
        headers=api.headers("admin"),
        json={"value": "dismissed"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["value"] == "dismissed"

    leido = api.get(f"/auth/me/preferences?venue_id={venue}", "admin").json()
    onboarding = next(p for p in leido["preferences"] if p["key"] == "onboarding")
    assert onboarding["value"] == "dismissed"


def test_guardar_dos_veces_actualiza_la_misma_fila(api, world, db):
    """UPSERT, no INSERT ciego: la clave es (user, venue, key)."""
    venue = world["venue_a"]
    for valor in ("accepted", "completed"):
        res = api.client.put(
            f"/auth/me/preferences/onboarding?venue_id={venue}",
            headers=api.headers("admin"),
            json={"value": valor},
        )
        assert res.status_code == 200, res.text

    filas = db.execute(
        "SELECT value FROM user_preferences WHERE user_id=%s AND venue_id=%s "
        "AND key='onboarding'",
        (world["admin"]["id"], venue),
    ).fetchall()
    assert len(filas) == 1
    assert filas[0]["value"] == "completed"


def test_el_paso_del_tutorial_se_guarda_y_se_retoma(api, world):
    """El avance del tutorial sobrevive a cerrar la app: es su razón de ser."""
    venue = world["venue_a"]
    res = api.client.put(
        f"/auth/me/preferences/tutorial?venue_id={venue}",
        headers=api.headers("admin"),
        json={"value": "accepted", "step": 3},
    )
    assert res.status_code == 200, res.text
    assert res.json()["step"] == 3

    leido = api.get(f"/auth/me/preferences?venue_id={venue}", "admin").json()
    tutorial = next(p for p in leido["preferences"] if p["key"] == "tutorial")
    assert (tutorial["value"], tutorial["step"]) == ("accepted", 3)


def test_valor_desconocido_no_entra_a_la_db(api, world):
    """El CHECK de la tabla es cerrado: la DB es del producto, no un cajón."""
    res = api.client.put(
        f"/auth/me/preferences/onboarding?venue_id={world['venue_a']}",
        headers=api.headers("admin"),
        json={"value": "lo-que-sea"},
    )
    assert res.status_code == 422, res.text


def test_clave_desconocida_no_entra_a_la_db(api, world):
    res = api.client.put(
        f"/auth/me/preferences/inventada?venue_id={world['venue_a']}",
        headers=api.headers("admin"),
        json={"value": "accepted"},
    )
    assert res.status_code == 422, res.text


def test_escribir_en_venue_ajena_es_403(api, world):
    res = api.client.put(
        f"/auth/me/preferences/onboarding?venue_id={world['venue_a']}",
        headers=api.headers("outsider"),
        json={"value": "dismissed"},
    )
    assert res.status_code == 403


# ---------------------------------------------------------------------------
# La promesa central: por PERSONA, no por navegador
# ---------------------------------------------------------------------------
def test_la_preferencia_es_del_usuario_no_del_dispositivo(api, world):
    """Dos usuarios de la misma venue deciden por separado.

    Es el bug que motivó la migración: en `localStorage` la decisión era del
    navegador, así que otro dispositivo (o otro origen de Vercel) volvía a
    ofrecer la guía ya rechazada."""
    venue = world["venue_a"]
    api.client.put(
        f"/auth/me/preferences/onboarding?venue_id={venue}",
        headers=api.headers("admin"),
        json={"value": "dismissed"},
    )

    # Otro miembro de la MISMA venue: su guía sigue sin decidir.
    leido = api.get(f"/auth/me/preferences?venue_id={venue}", "promoter").json()
    onboarding = next(p for p in leido["preferences"] if p["key"] == "onboarding")
    assert onboarding["value"] == "pending"


def test_la_preferencia_es_por_venue(api, world, db):
    """La misma persona en dos negocios tiene dos guías independientes.

    Se inserta la segunda membresía a mano porque el escenario base solo da una
    venue por usuario."""
    db.execute(
        "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, %s)",
        (world["venue_b"], world["admin"]["id"], "admin"),
    )
    api.client.put(
        f"/auth/me/preferences/onboarding?venue_id={world['venue_a']}",
        headers=api.headers("admin"),
        json={"value": "dismissed"},
    )

    leido = api.get(f"/auth/me/preferences?venue_id={world['venue_b']}", "admin").json()
    onboarding = next(p for p in leido["preferences"] if p["key"] == "onboarding")
    assert onboarding["value"] == "pending"


# ---------------------------------------------------------------------------
# Guardarraíl por forma (mig 039): una preferencia nueva no exige migración
# ---------------------------------------------------------------------------
def test_el_check_acepta_claves_con_forma_valida(db, world):
    """El CHECK dejó de ser lista cerrada: acepta cualquier clave con forma
    (minúsculas/dígitos/guion bajo, empezando por letra), sin migración."""
    db.execute(
        "INSERT INTO user_preferences (user_id, venue_id, key, value) "
        "VALUES (%s, %s, %s, %s)",
        (world["admin"]["id"], world["venue_a"], "density_compact", "accepted"),
    )
    row = db.execute(
        "SELECT value FROM user_preferences WHERE user_id=%s AND key=%s",
        (world["admin"]["id"], "density_compact"),
    ).fetchone()
    assert row["value"] == "accepted"


def test_el_check_rechaza_claves_sin_forma(db, world):
    """Sigue siendo guardarraíl: espacios, mayúsculas o claves vacías no entran."""
    import psycopg
    import pytest

    for bad in ("Density", "with space", "", "1starts_with_digit"):
        with pytest.raises(psycopg.errors.CheckViolation):
            db.execute(
                "INSERT INTO user_preferences (user_id, venue_id, key, value) "
                "VALUES (%s, %s, %s, %s)",
                (world["admin"]["id"], world["venue_a"], bad, "accepted"),
            )
