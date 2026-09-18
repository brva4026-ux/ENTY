"""Tests de Web Push: suscripción de dispositivos y permisos.

- GET /push/public-key expone la clave (o enabled=false sin configuración).
- POST /push/subscribe guarda/renueva la suscripción (upsert por endpoint).
- Solo miembros de la venue pueden suscribirse; el endpoint debe ser https.
- POST /push/unsubscribe solo borra las suscripciones del propio usuario.
- go_live dispara el envío (stub de notify_venue) sin romper la transición.

Las claves VAPID no están configuradas en el entorno de pruebas por defecto:
el push queda deshabilitado y eso también se prueba (public-key.enabled=false,
go_live funciona igual sin notificar a nadie).
"""

import base64
import os
import uuid

import pytest


def _fake_subscription() -> dict:
    """Suscripción con el shape de pushManager.subscribe() y claves de
    longitud/formato realistas (base64url de bytes P-256 y auth de 16)."""
    return {
        "endpoint": f"https://fcm.googleapis.com/fcm/send/{uuid.uuid4().hex}",
        "keys": {
            "p256dh": base64.urlsafe_b64encode(os.urandom(65)).rstrip(b"=").decode(),
            "auth": base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode(),
        },
    }


def test_public_key_shape(api_client, monkeypatch):
    """Sin claves -> enabled=False y sin clave; con claves -> expone la pública."""
    import app.core.config as config_mod

    settings = config_mod.get_settings()
    monkeypatch.setattr(settings, "vapid_private_key_b64", "", raising=False)
    monkeypatch.setattr(settings, "vapid_public_key_b64", "", raising=False)
    res = api_client.get("/push/public-key")
    assert res.status_code == 200
    body = res.json()
    assert body["enabled"] is False
    assert body["public_key"] is None

    monkeypatch.setattr(settings, "vapid_private_key_b64", "una-clave-privada", raising=False)
    monkeypatch.setattr(settings, "vapid_public_key_b64", "una-clave-publica", raising=False)
    body = api_client.get("/push/public-key").json()
    assert body["enabled"] is True
    assert body["public_key"] == "una-clave-publica"


def test_subscribe_and_upsert_by_endpoint(api, dbcur):
    venue = api.world["venue_a"]
    sub = _fake_subscription()

    res = api.post(
        "/push/subscribe",
        "bouncer",
        {"venue_id": venue, **sub},
    )
    assert res.status_code == 204, res.text

    dbcur.execute(
        "SELECT user_id, venue_id, p256dh, auth FROM push_subscriptions WHERE endpoint=%s",
        (sub["endpoint"],),
    )
    row = dbcur.fetchone()
    assert row is not None
    assert row["user_id"] == api.world["bouncer"]["id"]
    assert row["venue_id"] == venue
    assert row["p256dh"] == sub["keys"]["p256dh"]

    # Re-suscribir el mismo endpoint (renovación de claves del navegador)
    # actualiza en vez de duplicar (endpoint es UNIQUE).
    sub2 = _fake_subscription()
    sub2["endpoint"] = sub["endpoint"]
    res = api.post("/push/subscribe", "bouncer", {"venue_id": venue, **sub2})
    assert res.status_code == 204

    dbcur.execute(
        "SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint=%s",
        (sub["endpoint"],),
    )
    assert dbcur.fetchone()["n"] == 1
    dbcur.execute(
        "SELECT auth FROM push_subscriptions WHERE endpoint=%s", (sub["endpoint"],)
    )
    assert dbcur.fetchone()["auth"] == sub2["keys"]["auth"]


def test_subscribe_requires_membership(api):
    venue = api.world["venue_a"]
    sub = _fake_subscription()

    # El admin de la venue B no pertenece a la venue A -> 403.
    res = api.post("/push/subscribe", "outsider", {"venue_id": venue, **sub})
    assert res.status_code == 403

    # Venue inexistente: también 403 (ensure_roles corre primero y NO revela
    # si la venue existe: un id ajeno se comporta igual que uno inexistente).
    res = api.post("/push/subscribe", "admin", {"venue_id": 999999, **sub})
    assert res.status_code == 403


def test_subscribe_rejects_non_https_endpoint(api):
    venue = api.world["venue_a"]
    sub = _fake_subscription()
    sub["endpoint"] = "http://insegura.example/xyz"

    res = api.post("/push/subscribe", "bouncer", {"venue_id": venue, **sub})
    assert res.status_code == 422


def test_unsubscribe_only_own_subscription(api, dbcur):
    venue = api.world["venue_a"]
    sub = _fake_subscription()
    assert (
        api.post("/push/subscribe", "bouncer", {"venue_id": venue, **sub}).status_code
        == 204
    )

    # Otro usuario no puede borrar la suscripción ajena (aunque sea admin):
    # el DELETE filtra por user_id.
    res = api.post("/push/unsubscribe", "admin", {"endpoint": sub["endpoint"]})
    assert res.status_code == 204
    dbcur.execute(
        "SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint=%s",
        (sub["endpoint"],),
    )
    assert dbcur.fetchone()["n"] == 1

    # El dueño sí puede dar de baja su dispositivo.
    res = api.post("/push/unsubscribe", "bouncer", {"endpoint": sub["endpoint"]})
    assert res.status_code == 204
    dbcur.execute(
        "SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint=%s",
        (sub["endpoint"],),
    )
    assert dbcur.fetchone()["n"] == 0


def test_go_live_without_vapid_still_opens_doors(api):
    """Push deshabilitado: la transición published->live funciona igual."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Puerta sin push")
    api.publish("admin", venue, ev["id"])

    res = api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "live"


def test_go_live_sends_push_and_cleans_dead(api, dbcur, monkeypatch):
    """Con VAPID configurado, go_live notifica a la venue y limpia suscripciones muertas."""
    import app.core.config as config_mod
    import app.routers.lifecycle as lifecycle_mod

    venue = api.world["venue_a"]

    # Dos suscripciones de la venue A (bouncer) y una de la venue B (ajena).
    sub_a1 = _fake_subscription()
    sub_a2 = _fake_subscription()
    sub_b = _fake_subscription()
    for who, sub, vid in (
        ("bouncer", sub_a1, venue),
        ("bouncer", sub_a2, venue),
        ("outsider", sub_b, api.world["venue_b"]),
    ):
        assert (
            api.post("/push/subscribe", who, {"venue_id": vid, **sub}).status_code
            == 204
        )

    sent: list[str] = []

    async def fake_notify(rows, payload, *, vapid_private_b64, vapid_subject):
        sent.extend(r["endpoint"] for r in rows)
        # sub_a1 "muere" (404 del push service); las demás sobreviven.
        dead = [r["id"] for r in rows if r["endpoint"] == sub_a1["endpoint"]]
        return (dead, len(rows) - len(dead))

    monkeypatch.setattr(lifecycle_mod, "notify_venue", fake_notify)
    # Activar las claves VAPID en el settings cacheado (restaurado al salir).
    settings = config_mod.get_settings()
    monkeypatch.setattr(settings, "vapid_private_key_b64", "test-private-key-value", raising=False)

    ev = api.create_event("admin", venue, name="Puerta con push")
    api.publish("admin", venue, ev["id"])
    res = api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    assert res.status_code == 200, res.text

    # Se notifican las suscripciones de la venue A (incluidas las dejadas por
    # tests anteriores de la misma venue), nunca las de la venue B ajena.
    assert sub_a1["endpoint"] in sent
    assert sub_a2["endpoint"] in sent
    assert sub_b["endpoint"] not in sent

    # La suscripción muerta (primera del rows) fue eliminada.
    dbcur.execute(
        "SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint=%s",
        (sub_a1["endpoint"],),
    )
    assert dbcur.fetchone()["n"] == 0
    dbcur.execute(
        "SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint=%s",
        (sub_a2["endpoint"],),
    )
    assert dbcur.fetchone()["n"] == 1
