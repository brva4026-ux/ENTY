"""App del fan: "mis boletas" con enlace de acceso firmado.

El fan no tiene cuenta, pero el contacto (correo o telefono) NO es la
credencial: es un dato publico y adivinable. La credencial es el enlace firmado
que se entrega a ese contacto, o la POSESION del token crudo de otra boleta
suya. Este archivo fija ese contrato y, sobre todo, el ataque que cerro:
conocer el correo de alguien ya no alcanza para leer sus boletas ni para pedir
su QR (que rota el token y deja al dueno sin entrada).
"""
import uuid

from app.core.fan_access import create_fan_access_token


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


def _request_link(api_client, contact):
    """Pide el enlace: respuesta generica, sin boletas."""
    res = api_client.post("/public/my-tickets", json={"contact": contact})
    assert res.status_code == 200, res.text
    return res.json()


def _access(api_client, contact):
    """Lista las boletas con un enlace firmado valido para ese contacto."""
    token = create_fan_access_token(contact)
    res = api_client.post("/public/my-tickets/access", json={"token": token})
    assert res.status_code == 200, res.text
    return res.json()


def test_request_link_never_returns_tickets(api, api_client):
    """El contacto solo PIDE el enlace: la respuesta jamas trae boletas.

    Es la esencia del arreglo: antes esta misma llamada devolvia las boletas
    ajenas con solo conocer el correo.
    """
    scen = api.scenario()
    email = f"fan-{_tag()}@example.test"
    _emit(api, scen, email=email)

    body = _request_link(api_client, email)
    assert "tickets" not in body
    assert body["detail"]  # texto generico, igual con o sin boletas


def test_request_link_answer_is_the_same_for_known_and_unknown(api, api_client):
    """Anti-enumeracion: no se puede saber quien tiene boletas."""
    scen = api.scenario()
    known = f"fan-{_tag()}@example.test"
    _emit(api, scen, email=known)

    a = _request_link(api_client, known)
    b = _request_link(api_client, f"nadie-{_tag()}@example.test")
    assert a["detail"] == b["detail"]


def test_fan_sees_their_tickets_with_a_valid_link(api, api_client):
    scen = api.scenario()
    email = f"fan-{_tag()}@example.test"
    ticket = _emit(api, scen, email=email, name="Ana")

    body = _access(api_client, email.upper())  # el correo no distingue mayusculas
    assert body["count"] == 1
    row = body["tickets"][0]
    assert row["ticket_id"] == ticket["ticket_id"]
    assert row["event_name"] and row["venue_name"]
    assert row["has_link"] is True
    # El listado NUNCA expone el token crudo: para el QR se pide aparte.
    assert "raw_token" not in row and "token" not in row


def test_fan_sees_their_tickets_by_email_regardless_of_case(api, api_client):
    """El correo se guarda tal cual y se busca normalizado.

    `emit_ticket` no toca el `customer_email`, asi que una boleta emitida como
    "Fan@Bar.test" solo aparece si la comparacion baja la columna a minusculas.
    Sin esto el fan escribia su correo como lo recuerda y no encontraba nada:
    la misma clase de fallo que el telefono, pero del lado del correo.
    """
    scen = api.scenario()
    email = f"Fan-{_tag()}@Example.Test"
    ticket = _emit(api, scen, email=email)

    body = _access(api_client, email.lower())
    assert body["count"] == 1
    assert body["tickets"][0]["ticket_id"] == ticket["ticket_id"]


def test_fan_sees_their_tickets_by_phone_regardless_of_format(api, api_client):
    scen = api.scenario()
    # Numero unico (no colisiona con los fijos de la suite) con formato
    # internacional; se busca con otro formato equivalente (solo digitos).
    digits = _phone()
    spaced = f"+57 {digits[:3]} {digits[3:6]} {digits[6:]}"
    ticket = _emit(api, scen, phone=spaced)

    body = _access(api_client, f"57{digits}")
    assert body["count"] == 1
    assert body["tickets"][0]["ticket_id"] == ticket["ticket_id"]


def test_unknown_contact_sees_nothing(api, api_client):
    body = _access(api_client, f"nadie-{_tag()}@example.test")
    assert body["count"] == 0 and body["tickets"] == []


def test_access_rejects_invalid_and_tampered_tokens(api, api_client):
    """Un token inventado o alterado no abre nada (401 uniforme)."""
    for bad in ("no-es-un-token", create_fan_access_token("a@b.test") + "x"):
        res = api_client.post("/public/my-tickets/access", json={"token": bad})
        assert res.status_code == 401, res.text


def test_qr_window_is_reported_to_the_fan(api, api_client):
    scen = api.scenario()  # el evento del escenario empieza en +29h
    email = f"fan-{_tag()}@example.test"
    _emit(api, scen, email=email)

    row = _access(api_client, email)["tickets"][0]
    # El QR se activa 60 min antes del evento: a 29h aun no. La lista trae la
    # ventana para que la UI no muestre un QR que la puerta todavia no honra.
    assert row["qr_active"] is False
    assert row["qr_message"]


def test_fan_regenerates_qr_and_the_old_token_dies(api, api_client):
    scen = api.scenario()
    email = f"fan-{_tag()}@example.test"
    ticket = _emit(api, scen, email=email)

    res = api_client.post(
        f"/public/my-tickets/{ticket['ticket_id']}/token",
        json={"token": create_fan_access_token(email)},
    )
    assert res.status_code == 200, res.text
    new_token = res.json()["raw_token"]
    assert new_token and new_token != ticket["raw_token"]

    # El token nuevo abre la boleta; el viejo (el que circulaba) ya no.
    assert api_client.get(f"/public/tickets/{new_token}").status_code == 200
    assert api_client.get(f"/public/tickets/{ticket['raw_token']}").status_code == 404


def test_fan_recovers_another_qr_by_possession(api, api_client):
    """Quien tiene el QR de una boleta suya recupera el de otra, sin correo.

    La posesion del token es la credencial (mismo criterio que /t): permite al
    fan que ya tiene una entrada vigente pedir el QR de otra del mismo contacto.
    """
    scen = api.scenario()
    email = f"fan-{_tag()}@example.test"
    first = _emit(api, scen, email=email, name="Uno")
    second = _emit(api, scen, email=email, name="Dos")

    res = api_client.post(
        f"/public/my-tickets/{second['ticket_id']}/token",
        json={"raw_token": first["raw_token"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["raw_token"]


def test_fan_sees_their_tickets_by_possession(api, api_client):
    """Sin correo configurado, la posesion de un QR abre la lista completa.

    Es el camino real hoy (email_enabled=false en prod): el fan que ya tiene una
    boleta puede ver todas las de ese contacto sin depender del correo.
    """
    scen = api.scenario()
    email = f"fan-{_tag()}@example.test"
    first = _emit(api, scen, email=email, name="Uno")
    _emit(api, scen, email=email, name="Dos")

    res = api_client.post(
        "/public/my-tickets/access", json={"raw_token": first["raw_token"]}
    )
    assert res.status_code == 200, res.text
    assert res.json()["count"] == 2


def test_a_stranger_cannot_take_someone_elses_ticket(api, api_client):
    """El ataque medido: solo con el correo, pedir el QR ajeno.

    Antes devolvia 200 y el token crudo. Ahora sin credencial es 401, y con una
    credencial de OTRO contacto, 404 (no revelamos si la boleta existe).
    """
    scen = api.scenario()
    victim = _emit(api, scen, phone="3001112233", name="Victima")
    attacker = f"ladron-{_tag()}@example.test"

    # Sin credencial: 401.
    res = api_client.post(
        f"/public/my-tickets/{victim['ticket_id']}/token", json={}
    )
    assert res.status_code == 401

    # Con el correo del atacante como si fuera credencial: no es un token firmado.
    res2 = api_client.post(
        f"/public/my-tickets/{victim['ticket_id']}/token",
        json={"token": attacker},
    )
    assert res2.status_code == 401

    # Con un enlace firmado legitimo del atacante (no tiene boletas): 404.
    res3 = api_client.post(
        f"/public/my-tickets/{victim['ticket_id']}/token",
        json={"token": create_fan_access_token(attacker)},
    )
    assert res3.status_code == 404
