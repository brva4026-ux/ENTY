"""Puerta como espacio operativo (mig 064).

Cubre el contrato que no existía: un teléfono autorizado por puesto, el
relevo que lo invalida, y la incidencia compartida entre Puerta, Administración
y Promotor.
"""
from __future__ import annotations


def _open_doors(api, venue: int, event_id: int) -> None:
    # El QR se activa 60 min antes de starts_at; escenario nace +29h. Moverlo
    # al pasado es lo que hace que estos tests prueben canjes reales.
    api.run_sql(
        f"UPDATE events SET starts_at=now()-interval '1 hour', "
        f"ends_at=now()+interval '5 hours' WHERE id={event_id}"
    )
    res = api.post(f"/venues/{venue}/events/{event_id}/live", "admin")
    assert res.status_code == 200, res.text


def _assign_bouncer(api, venue: int, event_id: int, user: str, *, door="Acceso VIP", type_id=None):
    res = api.post(
        f"/venues/{venue}/events/{event_id}/staff",
        "admin",
        {
            "user_id": api.world[user]["id"],
            "role": "bouncer",
            "door_name": door,
            "door_ticket_type_id": type_id,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def _issue_link(api, venue: int, event_id: int, user: str, *, phone="3001234567"):
    res = api.post(
        f"/venues/{venue}/events/{event_id}/staff/{api.world[user]['id']}/link",
        "admin",
        {"door_name": "Acceso VIP", "ticket_type_id": None, "phone": phone},
    )
    assert res.status_code == 201, res.text
    return res.json()


def _redeem_link(api, token: str, user: str) -> dict:
    res = api.client.post(
        f"/escaner/acceso?token={token}",
        headers=api.headers(user),
    )
    assert res.status_code == 200, res.text
    return res.json()


def _door_headers(api, user: str, device_token: str) -> dict:
    return {**api.headers(user), "X-Door-Device": device_token}


def test_device_is_per_post_and_revocation_is_server_side(api):
    api = api
    scen = api.scenario()
    venue, event = scen["venue"], scen["event"]
    _open_doors(api, venue, event)
    _assign_bouncer(api, venue, event, "bouncer", type_id=scen["type"])
    link = _issue_link(api, venue, event, "bouncer")
    granted = _redeem_link(api, link["access_url"].split("token=", 1)[1], "bouncer")
    assert granted["device_id"]
    assert granted["door_name"] == "Acceso VIP"
    device_token = granted["device_token"]

    ticket = api.emit("admin", venue, event, ticket_type_id=scen["type"], allocation_id=None)
    res = api.client.post(
        f"/venues/{venue}/events/{event}/redeem",
        headers=_door_headers(api, "bouncer", device_token),
        json={"raw_token": ticket["raw_token"]},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["code"] == "GRANTED"
    assert body["ticket_type"] == "Cortesia"

    # Otro teléfono del mismo bouncer, sin el token del dispositivo, no opera.
    res = api.post(f"/venues/{venue}/events/{event}/redeem", "bouncer", {"raw_token": ticket["raw_token"]})
    assert res.status_code == 403, res.text

    # Administración revoca el puesto; el token viejo deja de servir.
    res = api.post(
        f"/venues/{venue}/events/{event}/door-devices/{granted['device_id']}/revoke",
        "admin",
    )
    assert res.status_code == 200, res.text
    other = api.emit("admin", venue, event, ticket_type_id=scen["type"], allocation_id=None)
    res = api.client.post(
        f"/venues/{venue}/events/{event}/redeem",
        headers=_door_headers(api, "bouncer", device_token),
        json={"raw_token": other["raw_token"]},
    )
    assert res.status_code == 403, res.text


def test_exit_and_occupancy_use_the_device_door(api):
    api = api
    scen = api.scenario()
    venue, event = scen["venue"], scen["event"]
    _open_doors(api, venue, event)
    _assign_bouncer(api, venue, event, "bouncer", type_id=scen["type"])
    link = _issue_link(api, venue, event, "bouncer")
    device = _redeem_link(api, link["access_url"].split("token=", 1)[1], "bouncer")
    ticket = api.emit("admin", venue, event, ticket_type_id=scen["type"], allocation_id=None)
    headers = _door_headers(api, "bouncer", device["device_token"])

    res = api.client.post(
        f"/venues/{venue}/events/{event}/redeem",
        headers=headers,
        json={"raw_token": ticket["raw_token"]},
    )
    assert res.status_code == 200 and res.json()["code"] == "GRANTED"

    res = api.client.get(f"/venues/{venue}/events/{event}/door-context", headers=headers)
    assert res.status_code == 200, res.text
    ctx = res.json()
    assert ctx["inside"] == 1
    assert ctx["assigned_door"] == "Acceso VIP"

    res = api.client.post(
        f"/venues/{venue}/events/{event}/exit",
        headers=headers,
        json={"raw_token": ticket["raw_token"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["code"] == "EXITED"
    assert res.json()["ticket_type"] == "Cortesia"

    ctx = api.client.get(f"/venues/{venue}/events/{event}/door-context", headers=headers).json()
    assert ctx["inside"] == 0
    assert ctx["exits"] == 1


def test_incident_is_shared_with_admin_and_promoter(api):
    api = api
    scen = api.scenario()
    venue, event = scen["venue"], scen["event"]
    _open_doors(api, venue, event)
    _assign_bouncer(api, venue, event, "bouncer", type_id=scen["type"])
    link = _issue_link(api, venue, event, "bouncer")
    device = _redeem_link(api, link["access_url"].split("token=", 1)[1], "bouncer")
    ticket = api.emit("admin", venue, event, ticket_type_id=scen["type"], allocation_id=None)
    headers = _door_headers(api, "bouncer", device["device_token"])

    res = api.client.post(
        f"/venues/{venue}/events/{event}/door-incidents",
        headers=headers,
        json={
            "reason": "Boleta duplicada",
            "note": "La persona muestra dos QR distintos.",
            "ticket_id": ticket["ticket_id"],
            "client_request_id": "inc-test-1",
        },
    )
    assert res.status_code == 201, res.text
    incident = res.json()
    assert incident["created_by_name"] == "Usuario bouncer"
    assert incident["ticket_ref"]

    # Un reintento con el mismo client_request_id no duplica.
    res = api.client.post(
        f"/venues/{venue}/events/{event}/door-incidents",
        headers=headers,
        json={
            "reason": "Boleta duplicada",
            "ticket_id": ticket["ticket_id"],
            "client_request_id": "inc-test-1",
        },
    )
    assert res.status_code == 201, res.text
    assert res.json()["id"] == incident["id"]

    # Administración ve el caso y pide apoyo al promotor.
    admin_list = api.get(f"/venues/{venue}/events/{event}/door-incidents", "admin")
    assert admin_list.status_code == 200
    assert any(i["id"] == incident["id"] for i in admin_list.json())

    res = api.post(
        f"/venues/{venue}/events/{event}/door-incidents/{incident['id']}/request-promoter",
        "admin",
        {"promoter_id": api.world["promoter"]["id"], "note": "¿Esta boleta se reemitió?"},
    )
    assert res.status_code == 200, res.text

    promoter_list = api.get(f"/venues/{venue}/events/{event}/door-incidents", "promoter")
    assert promoter_list.status_code == 200
    assert any(i["id"] == incident["id"] for i in promoter_list.json())

    res = api.post(
        f"/venues/{venue}/events/{event}/door-incidents/{incident['id']}/comments",
        "promoter",
        {"body": "Sí, la reemití y la anterior queda anulada.", "channel": "whatsapp"},
    )
    assert res.status_code == 200, res.text

    res = api.post(
        f"/venues/{venue}/events/{event}/door-incidents/{incident['id']}/status",
        "admin",
        {"status": "resolved", "guidance": "Dejar pasar con la boleta nueva."},
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "resolved"

    detail = api.client.get(
        f"/venues/{venue}/events/{event}/door-incidents/{incident['id']}",
        headers=headers,
    )
    assert detail.status_code == 200, detail.text
    assert detail.json()["resolution_guidance"] == "Dejar pasar con la boleta nueva."
    assert any(c["channel"] == "whatsapp" for c in detail.json()["comments"])


def test_shift_handover_revokes_old_phone(api):
    api = api
    scen = api.scenario()
    venue, event = scen["venue"], scen["event"]
    _open_doors(api, venue, event)
    _assign_bouncer(api, venue, event, "bouncer", type_id=scen["type"])
    # El reemplazo tiene que estar en el roster de Puerta de esa noche.
    _assign_bouncer(api, venue, event, "promoter2", type_id=scen["type"])
    link = _issue_link(api, venue, event, "bouncer")
    device = _redeem_link(api, link["access_url"].split("token=", 1)[1], "bouncer")
    headers = _door_headers(api, "bouncer", device["device_token"])

    res = api.client.post(
        f"/venues/{venue}/events/{event}/door-shift-requests",
        headers=headers,
        json={"reason": "Termina mi turno", "requested_phone": "3009998877"},
    )
    assert res.status_code == 201, res.text
    request = res.json()

    pending = api.get(f"/venues/{venue}/events/{event}/door-shift-requests", "admin")
    assert pending.status_code == 200
    assert any(r["id"] == request["id"] for r in pending.json())

    res = api.post(
        f"/venues/{venue}/events/{event}/door-shift-requests/{request['id']}/approve",
        "admin",
        {
            "user_id": api.world["promoter2"]["id"],
            "phone": "3009998877",
            "note": "Relevo confirmado.",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "approved"
    assert body["access_url"].startswith("/puerta?token=")

    # El teléfono viejo ya no puede operar: el servidor, no la UI, lo corta.
    ticket = api.emit("admin", venue, event, ticket_type_id=scen["type"], allocation_id=None)
    res = api.client.post(
        f"/venues/{venue}/events/{event}/redeem",
        headers=headers,
        json={"raw_token": ticket["raw_token"]},
    )
    assert res.status_code == 403, res.text


def test_admin_can_transfer_a_device_without_a_request(api):
    scen = api.scenario()
    venue, event = scen["venue"], scen["event"]
    _open_doors(api, venue, event)
    _assign_bouncer(api, venue, event, "bouncer", type_id=scen["type"])
    _assign_bouncer(api, venue, event, "promoter2", type_id=scen["type"])
    link = _issue_link(api, venue, event, "bouncer")
    device = _redeem_link(api, link["access_url"].split("token=", 1)[1], "bouncer")

    res = api.post(
        f"/venues/{venue}/events/{event}/door-devices/{device['device_id']}/transfer",
        "admin",
        {"user_id": api.world["promoter2"]["id"], "phone": "3008887766"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["access_url"].startswith("/puerta?token=")

    ticket = api.emit("admin", venue, event, ticket_type_id=scen["type"], allocation_id=None)
    res = api.client.post(
        f"/venues/{venue}/events/{event}/redeem",
        headers=_door_headers(api, "bouncer", device["device_token"]),
        json={"raw_token": ticket["raw_token"]},
    )
    assert res.status_code == 403, res.text
