"""Canal invitado (mig 077): importar boletas externas y operarlas en puerta."""
import hashlib

import psycopg
from psycopg.rows import dict_row


def _set_window(api, event_id: int) -> None:
    with psycopg.connect(api.dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE events SET starts_at = now() - interval '1 hour'"
                " WHERE id = %s",
                (event_id,),
            )


def _event(api):
    venue = api.world["venue_a"]
    event = api.create_event("admin", venue, capacity=100)
    api.add_type("admin", venue, event["id"], quantity=50, is_courtesy=True)
    api.publish("admin", venue, event["id"])
    api.post(f"/venues/{venue}/events/{event['id']}/live", "admin")
    _set_window(api, event["id"])
    return venue, event["id"]


def _channel(api, venue, event, **extra):
    payload = {
        "name": "Taquilla invitada",
        "provider_name": "Proveedor X",
        "confirmation_owner": "enty",
    }
    payload.update(extra)
    res = api.post(
        f"/venues/{venue}/events/{event}/external-channels", "admin", payload
    )
    assert res.status_code == 201, res.text
    return res.json()


def _import(api, venue, event, channel_id, rows, filename="boletas.csv"):
    return api.post(
        f"/venues/{venue}/events/{event}/external-channels/{channel_id}/import",
        "admin",
        {"filename": filename, "rows": rows},
    )


def _row(ext_id, token, name="Invitada", status="valid"):
    return {
        "external_ticket_id": ext_id,
        "token": token,
        "holder_name": name,
        "status": status,
    }


def test_external_channel_import_scan_and_reconciliation(api):
    venue, event = _event(api)
    channel = _channel(api, venue, event)
    assert channel["ticket_type_name"].startswith("Invitado ·")
    assert channel["status"] == "active"

    # La localidad tecnica no se ofrece como venta publica ni en el admin.
    types = api.types("admin", venue, event)
    assert all(not t["name"].startswith("Invitado ·") for t in types)

    tokens = {
        "valid1": "ext-valid-1-abcdefgh",
        "valid2": "ext-valid-2-abcdefgh",
        "void": "ext-void-abcdefgh",
        "used": "ext-used-abcdefgh",
    }
    rows = [
        _row("E-001", tokens["valid1"], "Ana Externa"),
        _row("E-002", tokens["valid2"], "Beto Externo"),
        _row("E-003", tokens["void"], "Carla Anulada", "void"),
        _row("E-004", tokens["used"], "Diego Usado", "used"),
    ]
    imported = _import(api, venue, event, channel["id"], rows)
    assert imported.status_code == 200, imported.text
    body = imported.json()
    assert body["imported"] == 4
    assert body["updated"] == 0
    assert body["skipped"] == 0

    # El token crudo no queda en la DB; solo su SHA-256.
    with psycopg.connect(api.dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT token_hash, origin, external_ticket_id, price_cents_snapshot,"
                " payment_method FROM tickets WHERE external_channel_id=%s"
                " ORDER BY external_ticket_id",
                (channel["id"],),
            )
            stored = cur.fetchall()
    assert len(stored) == 4
    assert stored[0]["token_hash"] == hashlib.sha256(
        tokens["valid1"].encode()
    ).hexdigest()
    assert all(r["origin"] == "external" for r in stored)
    assert all(r["price_cents_snapshot"] == 0 for r in stored)
    assert all(r["payment_method"] == "cortesia" for r in stored)

    listed = api.get(
        f"/venues/{venue}/events/{event}/external-channels", "admin"
    )
    assert listed.status_code == 200, listed.text
    counts = listed.json()[0]
    assert counts["total"] == 4
    assert counts["valid"] == 2
    assert counts["redeemed"] == 1
    assert counts["voided"] == 1

    # Snapshot offline: solo la boleta viva, con su origen y proveedor.
    snap = api.get(f"/venues/{venue}/events/{event}/door-snapshot", "admin")
    assert snap.status_code == 200, snap.text
    external_entries = [e for e in snap.json()["entries"] if e["o"] == "external"]
    assert len(external_entries) == 2
    assert all(e["c"] == "Proveedor X" for e in external_entries)

    # Primer ingreso: Enty confirma y la puerta ve el origen.
    first = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": tokens["valid1"], "door_id": "norte"},
    )
    assert first.status_code == 200, first.text
    assert first.json()["code"] == "GRANTED"
    assert first.json()["origin"] == "external"
    assert first.json()["origin_label"] == "Invitado · Proveedor X"

    second = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": tokens["valid1"]},
    )
    assert second.status_code == 200, second.text
    assert second.json()["code"] == "ALREADY_REDEEMED"
    assert second.json()["origin"] == "external"

    voided = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": tokens["void"]},
    )
    assert voided.status_code == 200, voided.text
    assert voided.json()["code"] == "NOT_VALID"
    assert voided.json()["origin"] == "external"

    already_used = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": tokens["used"]},
    )
    assert already_used.status_code == 200, already_used.text
    assert already_used.json()["code"] == "ALREADY_REDEEMED"
    assert already_used.json()["origin"] == "external"

    # Pausar el canal frena la segunda boleta sin consumirla.
    paused = api.patch(
        f"/venues/{venue}/events/{event}/external-channels/{channel['id']}",
        "admin",
        {"status": "paused"},
    )
    assert paused.status_code == 200, paused.text
    blocked = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": tokens["valid2"]},
    )
    assert blocked.status_code == 200, blocked.text
    assert blocked.json()["code"] == "CHANNEL_PAUSED"
    assert blocked.json()["origin"] == "external"

    recon = api.get(
        f"/venues/{venue}/events/{event}/external-channels/{channel['id']}/reconciliation",
        "admin",
    )
    assert recon.status_code == 200, recon.text
    data = recon.json()
    assert data["redeemed"] == 2  # la usada importada + la que entró por Enty
    assert data["by_door"] == [{"door_id": "norte", "count": 1}]
    assert data["external_total"] == 3  # valid1, valid2 y la usada importada


def test_external_channel_provider_confirmation_does_not_consume(api):
    venue, event = _event(api)
    channel = _channel(
        api, venue, event, name="Proveedor confirma", confirmation_owner="provider"
    )
    token = "provider-token-abcdefgh"
    imported = _import(api, venue, event, channel["id"], [_row("P-1", token)])
    assert imported.status_code == 200, imported.text

    res = api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "admin",
        {"raw_token": token},
    )
    assert res.status_code == 200, res.text
    assert res.json()["code"] == "EXTERNAL_CONFIRMATION_REQUIRED"
    assert res.json()["origin"] == "external"
    assert "Proveedor X" in res.json()["detail"]

    with psycopg.connect(api.dsn, autocommit=True, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status FROM tickets WHERE external_channel_id=%s",
                (channel["id"],),
            )
            assert cur.fetchone()["status"] == "issued"

    listed = api.get(
        f"/venues/{venue}/events/{event}/external-channels/{channel['id']}/tickets",
        "admin",
    )
    ticket_id = listed.json()[0]["id"]
    manual = api.post(
        f"/venues/{venue}/events/{event}/door/manual-admission",
        "admin",
        {
            "ticket_id": ticket_id,
            "reason": "Sin batería",
            "verification": "Documento",
        },
    )
    assert manual.status_code == 409, manual.text
    assert "Proveedor X" in manual.text


def test_external_channel_reimport_updates_and_rejects_collisions(api):
    venue, event = _event(api)
    channel = _channel(api, venue, event)
    token = "reimport-token-abcdefgh"
    first = _import(api, venue, event, channel["id"], [_row("R-1", token, "Nombre viejo")])
    assert first.status_code == 200, first.text

    second = _import(
        api, venue, event, channel["id"],
        [_row("R-1", token, "Nombre nuevo", "void")],
    )
    assert second.status_code == 200, second.text
    assert second.json()["updated"] == 1
    assert second.json()["imported"] == 0

    listed = api.get(
        f"/venues/{venue}/events/{event}/external-channels/{channel['id']}/tickets",
        "admin",
    )
    assert listed.status_code == 200, listed.text
    assert listed.json()[0]["customer_name"] == "Nombre nuevo"
    assert listed.json()[0]["status"] == "voided"

    # Dos filas con el mismo token no entran: una se rechaza y la otra queda.
    dup = _import(
        api, venue, event, channel["id"],
        [
            _row("R-2", "collision-token-abcdefgh", "Uno"),
            _row("R-3", "collision-token-abcdefgh", "Dos"),
        ],
    )
    assert dup.status_code == 200, dup.text
    assert dup.json()["skipped"] == 1
    assert dup.json()["imported"] == 1


def test_external_channel_is_venue_scoped(api):
    venue, event = _event(api)
    channel = _channel(api, venue, event)
    outsider_venue = api.world["venue_b"]

    denied = api.post(
        f"/venues/{outsider_venue}/events/{event}/external-channels",
        "outsider",
        {"name": "Ajeno", "provider_name": "X", "confirmation_owner": "enty"},
    )
    assert denied.status_code == 404, denied.text

    imported = api.post(
        f"/venues/{outsider_venue}/events/{event}/external-channels/{channel['id']}/import",
        "outsider",
        {"filename": "x.csv", "rows": [_row("X-1", "outsider-token-abcdefgh")]},
    )
    assert imported.status_code == 404, imported.text
