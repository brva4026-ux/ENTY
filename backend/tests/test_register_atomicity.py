"""Registro: si algo falla a mitad, no debe quedar media cuenta creada.

Regresión de la mig 044 (atomicidad). `/register` escribe en varias tablas
(venue, user, roles, aceptaciones legales). El endpoint confiaba en
`db.commit()` para que fuera todo-o-nada, pero las conexiones son
`autocommit=True` (core/db.py): cada statement se confirma solo, así que un
fallo DESPUÉS del INSERT de la venue dejaba la venue huérfana en la base.
El fix envuelve el bloque en `db.transaction()`.
"""
import uuid

from app.routers import auth as auth_mod


def test_register_leaves_no_partial_rows_on_failure(api, monkeypatch):
    email = f"atomic-{uuid.uuid4().hex[:8]}@test.com"
    venue_name = f"Venue Atomica {uuid.uuid4().hex[:6]}"

    async def boom(*args, **kwargs):
        raise RuntimeError("fallo simulado tras crear la venue")

    monkeypatch.setattr(auth_mod, "record_acceptances", boom)

    # El registro revienta a mitad (después de crear venue + user).
    try:
        api.client.post(
            "/auth/register",
            json={
                "email": email,
                "password": "ClaveSegura123",
                "full_name": "Fan Atomico",
                "venue_name": venue_name,
                "accepted_terms": True,
            },
        )
    except RuntimeError:
        pass

    # Invariante: no puede quedar una venue sin su usuario/rol.
    orphan = api.run_sql(
        "SELECT count(*) FROM venues WHERE name = '%s'" % venue_name
    )
    assert orphan == 0, "quedó una venue huérfana tras un registro fallido"
