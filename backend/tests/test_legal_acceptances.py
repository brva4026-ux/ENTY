"""Aceptación versionada de los documentos legales (mig 028).

Lo que estos tests fijan, en orden de importancia:

1. Sin aceptación NO se crea la cuenta, y no queda una fila de usuario a medias.
2. Cuando sí se acepta, queda la prueba: versión, IP, agente y venue.
3. La versión se lee de la DB, no del request: el cliente no elige qué aceptó.
4. Una versión nueva invalida la huella y el registro pide recargar (409).
5. La integridad la sostiene la DB, no el router: no existe la aceptación de un
   documento que no está en el catálogo, ni una aceptación sin sujeto.
"""
import psycopg
import pytest


def _required(db) -> dict[str, str]:
    """Documentos que exigen aceptación y su versión vigente.

    Misma regla que legal_missing_acceptances en la DB: la versión MÁS
    RECIENTE de cada slug (por created_at, no por texto de versión).
    """
    rows = db.execute(
        """
        SELECT d.slug, d.version
          FROM legal_documents d
         WHERE d.requires_acceptance
           AND d.created_at = (
                 SELECT max(d2.created_at) FROM legal_documents d2
                  WHERE d2.slug = d.slug
               )
         ORDER BY d.slug
        """
    ).fetchall()
    return {r["slug"]: r["version"] for r in rows}


def _register(api_client, email: str, **extra):
    payload = {
        "venue_name": "Bar Legal",
        "full_name": "Dueno Legal",
        "email": email,
        "password": "ClaveLegal1",
    }
    payload.update(extra)
    return api_client.post("/auth/register", json=payload)


# ---------------------------------------------------------------------------
# 1. El registro exige la aceptación
# ---------------------------------------------------------------------------
def test_register_without_acceptance_creates_nothing(api_client, db):
    email = "sin-aceptar@example.test"
    res = _register(api_client, email)
    assert res.status_code == 422
    assert "T" in res.json()["detail"] and "rminos" in res.json()["detail"]

    # Ni usuario, ni venue, ni aceptación: el rechazo ocurre ANTES de escribir.
    assert db.execute(
        "SELECT 1 FROM users WHERE email = %s", (email,)
    ).fetchone() is None
    assert db.execute(
        "SELECT 1 FROM venues WHERE name = %s", ("Bar Legal",)
    ).fetchone() is None


def test_register_with_explicit_false_is_rejected(api_client, db):
    """Un cliente que manda el campo en false tampoco pasa."""
    res = _register(api_client, "acepto-false@example.test", accepted_terms=False)
    assert res.status_code == 422


# ---------------------------------------------------------------------------
# 2. La aceptación queda probada
# ---------------------------------------------------------------------------
def test_register_records_versioned_acceptance(api_client, db):
    email = "con-acepto@example.test"
    res = _register(api_client, email, accepted_terms=True)
    assert res.status_code == 201

    rows = db.execute(
        """
        SELECT a.document_slug AS slug, a.document_version AS version,
               a.ip, a.user_agent, a.venue_id, a.accepted_at
          FROM legal_acceptances a
          JOIN users u ON u.id = a.user_id
         WHERE lower(u.email) = %s
         ORDER BY a.document_slug
        """,
        (email,),
    ).fetchall()

    # Una fila por documento exigible, con LA versión vigente del catálogo.
    assert {r["slug"]: r["version"] for r in rows} == _required(db)

    # El aviso de cookies no exige aceptación: no debe aparecer.
    assert "cookies" not in {r["slug"] for r in rows}

    for r in rows:
        assert r["ip"] == "testclient", "la IP es parte de la prueba"
        assert r["user_agent"], "el agente de usuario es parte de la prueba"
        assert r["venue_id"], "la aceptación se atribuye al bar"
        assert r["accepted_at"] is not None


def test_register_with_stale_terms_version_is_rejected(api_client, db):
    """Si los términos cambiaron mientras se llenaba el formulario: 409."""
    res = _register(
        api_client, "huella-vieja@example.test",
        accepted_terms=True, terms_version="0000000000000000",
    )
    assert res.status_code == 409
    assert "Recarga" in res.json()["detail"]
    assert db.execute(
        "SELECT 1 FROM users WHERE email = %s", ("huella-vieja@example.test",)
    ).fetchone() is None


def test_register_accepts_the_version_of_the_documents_endpoint(api_client):
    """El flujo real: el frontend pide la huella y la devuelve tal cual."""
    catalog = api_client.get("/legal/documents")
    assert catalog.status_code == 200
    terms_version = catalog.json()["terms_version"]

    res = _register(
        api_client, "huella-ok@example.test",
        accepted_terms=True, terms_version=terms_version,
    )
    assert res.status_code == 201


# ---------------------------------------------------------------------------
# 3. Versionar de verdad: una versión nueva cambia la huella y el pendiente
# ---------------------------------------------------------------------------
def test_new_version_changes_fingerprint_and_shows_as_pending(api_client, db):
    before = api_client.get("/legal/documents").json()

    # La versión nueva rige desde que se publica (created_at manda).
    # Es 2.0 y no 1.1 porque esa ya es la publicada por la migración 029: el
    # test necesita una versión que NADIE haya registrado todavía.
    db.execute(
        """
        INSERT INTO legal_documents
            (slug, version, title, url, requires_acceptance, effective_date)
        VALUES ('privacidad', '2.0', 'Politica v2.0', '/privacidad', true, '2026-11-01')
        """
    )
    try:
        after = api_client.get("/legal/documents").json()
        assert after["terms_version"] != before["terms_version"]
        privacy = [d for d in after["documents"] if d["slug"] == "privacidad"][0]
        assert privacy["version"] == "2.0"

        # Un usuario que ya había aceptado ve la versión nueva como pendiente.
        catalog = before["terms_version"]
        res = _register(
            api_client, "sin-lo-nuevo@example.test",
            accepted_terms=True, terms_version=catalog,
        )
        assert res.status_code == 409, "la huella vieja ya no vale"

        res = _register(
            api_client, "con-lo-nuevo@example.test",
            accepted_terms=True, terms_version=after["terms_version"],
        )
        assert res.status_code == 201
        token = res.json()["access_token"]

        status = api_client.get(
            "/legal/status", headers={"Authorization": f"Bearer {token}"}
        )
        assert status.status_code == 200
        body = status.json()
        assert body["pending"] == [], "acepto todo lo vigente al registrarse"
        assert {a["slug"] for a in body["accepted"]} >= {"privacidad"}
    finally:
        # La FK impide borrar una versión que alguien ya aceptó: eso es parte del
        # diseño (la prueba del consentimiento no se puede evaporar). Se verifica
        # aquí mismo, porque es la garantía que sostiene todo lo demás.
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            db.execute(
                "DELETE FROM legal_documents WHERE slug = 'privacidad' AND version = '2.0'"
            )
        # El fixture `db` es de sesión: sin esta limpieza, la versión 2.0
        # quedaría vigente para el resto de la corrida y ensuciaría otros tests.
        db.execute(
            "DELETE FROM legal_acceptances "
            "WHERE document_slug = 'privacidad' AND document_version = '2.0'"
        )
        db.execute(
            "DELETE FROM legal_documents WHERE slug = 'privacidad' AND version = '2.0'"
        )


def test_status_reports_pending_when_terms_change_after_accepting(api, db):
    """El caso que hace útil versionar: los términos cambian y hay que reaceptar."""
    # El admin del fixture nunca aceptó nada (se creó directo en la DB).
    status = api.get("/legal/status", "admin")
    assert status.status_code == 200
    body = status.json()
    assert {d["slug"] for d in body["pending"]} == set(_required(db))
    assert body["accepted"] == []

    # Acepta lo vigente y deja de tener pendientes.
    for slug in _required(db):
        assert api.post(
            "/legal/acceptances", "admin", {"slug": slug, "version": _required(db)[slug]}
        ).status_code == 201
    assert api.get("/legal/status", "admin").json()["pending"] == []


# ---------------------------------------------------------------------------
# 4. El endpoint público de aceptación
# ---------------------------------------------------------------------------
def test_acceptance_requires_an_identifiable_subject(api_client):
    res = api_client.post(
        "/legal/acceptances",
        json={"slug": "terminos-boleta", "version": "1.0"},
    )
    assert res.status_code == 422
    assert "telefono" in res.json()["detail"] or "correo" in res.json()["detail"]


def test_acceptance_of_unknown_document_is_404(api_client):
    res = api_client.post(
        "/legal/acceptances",
        json={"slug": "no-existe", "version": "1.0", "subject_phone": "3001234567"},
    )
    assert res.status_code == 404


def test_acceptance_of_superseded_version_is_conflict(api_client):
    res = api_client.post(
        "/legal/acceptances",
        json={"slug": "privacidad", "version": "0.9", "subject_phone": "3001234567"},
    )
    assert res.status_code == 409


def test_acceptance_is_idempotent_for_an_account(api, db):
    """Tocar 'acepto' dos veces (o el reintento del frontend) no duplica."""
    catalog = api.client.get("/legal/documents").json()
    payload = {
        "slug": "terminos-boleta",
        "version": next(
            d["version"] for d in catalog["documents"]
            if d["slug"] == "terminos-boleta"
        ),
    }
    # Nota: para una cuenta NO se exige teléfono; el correo sale del token.
    first = api.post("/legal/acceptances", "admin", payload)
    second = api.post("/legal/acceptances", "admin", payload)
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["accepted_at"] == second.json()["accepted_at"]

    n = db.execute(
        """
        SELECT count(*) AS n FROM legal_acceptances
         WHERE user_id = %s AND document_slug = %s AND document_version = %s
        """,
        (api.world["admin"]["id"], payload["slug"], payload["version"]),
    ).fetchone()["n"]
    assert n == 1


def test_acceptance_with_bad_token_is_unauthorized(api_client):
    """Token presente pero inválido: 401, no 'anónimo'."""
    res = api_client.post(
        "/legal/acceptances",
        headers={"Authorization": "Bearer token-invalido"},
        json={"slug": "privacidad", "version": "1.0", "subject_phone": "3001234567"},
    )
    assert res.status_code == 401


def test_acceptance_with_ticket_token_is_attributed_to_its_venue(api, db):
    """El invitado sin cuenta: el token de su boleta resuelve el venue."""
    venue = api.world["venue_a"]
    event = api.create_event("admin", venue, name="Evento legal")
    api.publish("admin", venue, event["id"])
    ttype = api.add_type("admin", venue, event["id"], name="General")
    ticket = api.emit(
        "admin", venue, event["id"],
        ticket_type_id=ttype["id"], allocation_id=None,
    )

    # La versión se lee del catálogo: hardcodearla aqui fue lo que dejó
    # estos tests rotos cada vez que se publica una versión nueva.
    catalog = api.client.get("/legal/documents").json()
    version = next(
        d["version"] for d in catalog["documents"] if d["slug"] == "terminos-boleta"
    )

    res = api.client.post(
        "/legal/acceptances",
        json={
            "slug": "terminos-boleta",
            "version": version,
            "ticket_token": ticket["raw_token"],
        },
    )
    assert res.status_code == 201, res.text

    row = db.execute(
        """
        SELECT venue_id, subject_phone, user_id, ip
          FROM legal_acceptances
         WHERE document_slug = 'terminos-boleta'
           AND subject_phone = '3001234567'
         ORDER BY id DESC LIMIT 1
        """
    ).fetchone()
    assert row is not None, "la aceptación del invitado no se registró"
    assert row["venue_id"] == venue
    assert row["user_id"] is None, "el invitado no tiene cuenta"
    assert row["ip"] == "testclient"


def test_acceptance_with_unknown_ticket_token_is_404(api_client):
    res = api_client.post(
        "/legal/acceptances",
        json={
            "slug": "terminos-boleta",
            "version": "1.0",
            "ticket_token": "token-que-no-existe-1234567890",
        },
    )
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# 5. El texto de los documentos se sirve desde los assets
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "slug, esperado",
    [
        ("terminos-plataforma", "ley 1480 de 2011"),
        ("terminos-boleta", "derecho de retracto"),
        ("privacidad", "ley 1581 de 2012"),
        ("cookies", "tf_token"),
        ("encargo-datos", "encargado"),
    ],
)
def test_document_body_is_deployed_and_mentions_colombian_law(api_client, slug, esperado):
    """Cada documento está desplegado y cita el marco colombiano que le toca.

    La comparación es en minúsculas para no acoplar el test al uso de mayúsculas
    del redactor ("Derecho de retracto" vs "derecho de retracto").
    """
    res = api_client.get(f"/legal/documents/{slug}")
    assert res.status_code == 200, f"{slug} no está desplegado"
    assert esperado in res.text.lower()


def test_unknown_document_body_is_404(api_client):
    for slug in ("no-existe", "../schema", "privacidad/../../db/schema"):
        assert api_client.get(f"/legal/documents/{slug}").status_code == 404


def test_catalog_lists_every_required_document(api_client, db):
    catalog = api_client.get("/legal/documents").json()
    assert {d["slug"] for d in catalog["documents"]} == {
        "terminos-plataforma", "terminos-boleta", "privacidad", "cookies",
        "encargo-datos",
    }
    # El único informativo (no se acepta) es el aviso de cookies.
    informativos = {d["slug"] for d in catalog["documents"] if not d["requires_acceptance"]}
    assert informativos == {"cookies"}


# ---------------------------------------------------------------------------
# 6. La integridad la sostiene la DB, no el router
# ---------------------------------------------------------------------------
def test_db_rejects_acceptance_of_a_version_outside_the_catalog(db):
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        db.execute(
            """
            INSERT INTO legal_acceptances
                (document_slug, document_version, subject_email)
            VALUES ('privacidad', '9.9', 'nadie@example.test')
            """
        )


def test_db_rejects_acceptance_without_a_subject(db):
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(
            """
            INSERT INTO legal_acceptances
                (document_slug, document_version, ip)
            VALUES ('privacidad', '1.0', '10.0.0.1')
            """
        )


def test_db_rejects_unknown_document_slug(db):
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(
            """
            INSERT INTO legal_documents
                (slug, version, title, url, effective_date)
            VALUES ('Con Mayusculas!', '1.0', 'x', '/x', '2026-10-15')
            """
        )
