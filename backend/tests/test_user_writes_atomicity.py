"""Escrituras de equipo (lifecycle): todo-o-nada, sin dejar estado a medias.

Los endpoints de usuarios escriben en varias tablas. La conexión es
`autocommit=True` (core/db.py): sin `db.transaction()`, cada statement se
confirma solo y un fallo a mitad deja un estado incoherente. Estos tests
inyectan el fallo con un trigger REAL (no un mock) en el punto exacto donde
antes quedaba la escritura a medias, y comprueban que el rollback la deshizo.
"""
import uuid

import pytest


def _make_member(api, venue_id: int, role: str) -> int:
    """Inserta un usuario activo con un rol en la venue. Devuelve su id."""
    tag = uuid.uuid4().hex[:8]
    uid = api.run_sql(
        "INSERT INTO users (email, password_hash, full_name) "
        "VALUES ('member-%s@test.com', 'x', 'Miembro') RETURNING id" % tag
    )
    api.run_sql(
        "INSERT INTO venue_user_roles (venue_id, user_id, role) "
        "VALUES (%d, %d, '%s')" % (venue_id, uid, role)
    )
    return uid


def _roles_of(api, venue_id: int, user_id: int) -> list[str]:
    raw = api.run_sql(
        "SELECT coalesce(string_agg(role::text, ',' ORDER BY role::text), '') "
        "FROM venue_user_roles WHERE venue_id = %d AND user_id = %d"
        % (venue_id, user_id)
    )
    return [r for r in (raw or "").split(",") if r]


def _drop(api, *objects):
    for obj in objects:
        api.run_sql(f"DROP {obj}")


def test_role_change_is_atomic(api):
    """Si el INSERT del rol nuevo falla, el rol viejo no se pierde.

    Sin transacción: el DELETE del rol viejo ya se había confirmado (autocommit)
    y el usuario quedaba sin NINGÚN rol.
    """
    venue = api.world["venue_a"]
    uid = _make_member(api, venue, "promotor")

    # Trigger que revienta al insertar CUALQUIER rol para este usuario.
    api.run_sql(
        "CREATE FUNCTION _boom_role() RETURNS trigger AS $$ "
        "BEGIN RAISE EXCEPTION 'boom en INSERT de rol'; END $$ LANGUAGE plpgsql"
    )
    api.run_sql(
        "CREATE TRIGGER _boom_role_trg BEFORE INSERT ON venue_user_roles "
        "FOR EACH ROW WHEN (NEW.user_id = %d) "
        "EXECUTE FUNCTION _boom_role()" % uid
    )
    try:
        with pytest.raises(Exception):
            api.patch(f"/venues/{venue}/users/{uid}", "admin", {"role": "bouncer"})
    finally:
        _drop(api, "TRIGGER _boom_role_trg ON venue_user_roles", "FUNCTION _boom_role()")

    # Invariante: sigue con su rol original (el DELETE se revirtió).
    assert _roles_of(api, venue, uid) == ["promotor"], (
        "el cambio de rol falló y dejó al usuario sin rol"
    )


def test_remove_member_is_atomic(api):
    """Si el UPDATE de desactivación falla, el rol no se pierde.

    `remove_venue_user` borra el rol y, si el usuario queda sin venues, lo
    desactiva. Sin transacción, un fallo en el UPDATE dejaba al usuario sin rol
    pero activo (incoherente).
    """
    venue = api.world["venue_a"]
    uid = _make_member(api, venue, "promotor")

    api.run_sql(
        "CREATE FUNCTION _boom_user() RETURNS trigger AS $$ "
        "BEGIN RAISE EXCEPTION 'boom en UPDATE de usuario'; END $$ LANGUAGE plpgsql"
    )
    api.run_sql(
        "CREATE TRIGGER _boom_user_trg BEFORE UPDATE ON users "
        "FOR EACH ROW WHEN (NEW.id = %d) "
        "EXECUTE FUNCTION _boom_user()" % uid
    )
    try:
        with pytest.raises(Exception):
            api.delete(f"/venues/{venue}/users/{uid}", "admin")
    finally:
        _drop(api, "TRIGGER _boom_user_trg ON users", "FUNCTION _boom_user()")

    assert _roles_of(api, venue, uid) == ["promotor"], (
        "el borrado de miembro falló y dejó al usuario sin rol"
    )
