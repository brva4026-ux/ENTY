"""App del fan: "mis boletas" por contacto (magic link).

El fan no tiene cuenta: el correo o telefono con que le emitieron la boleta es
su identidad. Pide su lista, y para la boleta que va a usar regenera el QR
(`/public/my-tickets/{id}/token`). El token viejo muere: en la DB solo vive su
hash y la reemision lo rota.
"""
import uuid


def _tag() -> str:
    return uuid.uuid4().hex[:8]


def _phone() -> str:
    """Telefono unico de 10 digitos: la suite completa siembra boletas con
    numeros fijos (573001234567, 3001234567...) que colisionarian."""
    return "3" + str(uuid.uuid4().int)[:9]


def _emit(api, scen, *, phone=None, email=None, name="Ana Perez"):
    payload = {
        "ticket_type_id": scen["type"],
        "allocation_id": scen["allocation"]["id"],
        "customer_name": name,
        "customer_phone": phone or _phone(),
    }
    if email:
        payload["customer_email"] = email
    res = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets", "promoter", payload
    )
    assert res.status_code == 201, res.text
    return res.json()


def _lookup(api_client, contact):
    res = api_client.post("/public/my-tickets", json={"contact": contact})
    assert res.status_code == 200, res.text
    return res.json()


def test_fan_sees_their_tickets_by_email(api, api_client):
    scen = api.scenario()
    email = f"fan-{_tag()}@example.test"
    ticket = _emit(api, scen, email=email, name="Ana")

    body = _lookup(api_client, email.upper())  # el correo no distingue mayusculas
    assert body["count"] == 1
    row = body["tickets"][0]
    assert row["ticket_id"] == ticket["ticket_id"]
    assert row["event_name"] and row["venue_name"]
    assert row["has_link"] is True
    # El listado NUNCA expone el token crudo: para el QR se pide aparte.
    assert "raw_token" not in row and "token" not in row


def test_fan_sees_their_tickets_by_phone_regardless_of_format(api, api_client):
    scen = api.scenario()
    # Numero unico (no colisiona con los fijos de la suite) con formato
    # internacional; se busca con otro formato equivalente (solo digitos).
    digits = _phone()
    spaced = f"+57 {digits[:3]} {digits[3:6]} {digits[6:]}"
    ticket = _emit(api, scen, phone=spaced)

    body = _lookup(api_client, f"57{digits}")
    assert body["count"] == 1
    assert body["tickets"][0]["ticket_id"] == ticket["ticket_id"]


def test_unknown_contact_sees_nothing(api, api_client):
    body = _lookup(api_client, f"nadie-{_tag()}@example.test")
    assert body["count"] == 0 and body["tickets"] == []


def test_fan_regenerates_qr_and_the_old_token_dies(api, api_client):
    scen = api.scenario()
    email = f"fan-{_tag()}@example.test"
    ticket = _emit(api, scen, email=email)

    res = api_client.post(
        f"/public/my-tickets/{ticket['ticket_id']}/token", json={"contact": email}
    )
    assert res.status_code == 200, res.text
    new_token = res.json()["raw_token"]
    assert new_token and new_token != ticket["raw_token"]

    # El token nuevo abre la boleta; el viejo (el que circulaba) ya no.
    assert api_client.get(f"/public/tickets/{new_token}").status_code == 200
    assert api_client.get(f"/public/tickets/{ticket['raw_token']}").status_code == 404


def test_a_fan_cannot_take_someone_elses_ticket(api, api_client):
    scen = api.scenario()
    victim = _emit(api, scen, phone="3001112233")
    attacker = f"ladron-{_tag()}@example.test"

    res = api_client.post(
        f"/public/my-tickets/{victim['ticket_id']}/token", json={"contact": attacker}
    )
    assert res.status_code == 404
