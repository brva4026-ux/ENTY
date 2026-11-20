"""Ocupación en vivo y egresos por HTTP (fase 1 del V2).

El escáner y el tablero necesitan dos cosas que el backend no daba:

- `GET /events/{id}/occupancy`: cuánta gente hay ADENTRO ahora. `/pulse`
  cuenta ingresos acumulados de la noche, que es otra pregunta: 300
  ingresos pueden ser 300 personas dentro o 100 que ya se fueron.
- `POST /events/{id}/exit`: registrar la salida. Sin esto `inside` solo
  crece, el aforo se llena y el recinto se bloquea para siempre.

Los dos exigen el mismo rol que el resto de la puerta (bouncer incluido) y
respetan el aislamiento por venue.
"""
import uuid


def _tag() -> str:
    return uuid.uuid4().hex[:8]


def _open_night(api, *, capacity=10, quantity=10):
    """Evento publicado, EN PUERTA y con la ventana del QR abierta."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Ocupacion {_tag()}", capacity=capacity)
    tipo = api.add_type(
        "admin", venue, ev["id"], name="General", price_cents=1000,
        quantity=quantity, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    api.run_sql(
        f"UPDATE events SET starts_at = now() - interval '1 hour' WHERE id = {ev['id']}"
    )
    res = api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    assert res.status_code == 200, res.text
    return venue, ev["id"], tipo["id"]


def _enter(api, venue, event_id, type_id, name="Asistente"):
    """Emite una boleta y la canjea en la puerta."""
    ticket = api.emit("admin", venue, event_id, ticket_type_id=type_id, allocation_id=None)
    canje = api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer",
        {"raw_token": ticket["raw_token"]},
    )
    assert canje.status_code == 200, canje.text
    assert canje.json()["redeemed"] is True, canje.text
    return ticket


def test_occupancy_starts_empty(api):
    """Antes de abrir: cero adentro, y el aforo completo libre."""
    venue, event_id, _ = _open_night(api)

    res = api.get(f"/venues/{venue}/events/{event_id}/occupancy", "bouncer")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["inside"] == 0, body
    assert body["unique_admitted"] == 0, body
    assert body["free_seats"] == body["capacity"], body


def test_occupancy_counts_people_inside_not_scans(api):
    """Dos personas entran: `inside` es 2, no el total de escaneos."""
    venue, event_id, type_id = _open_night(api)
    _enter(api, venue, event_id, type_id)
    _enter(api, venue, event_id, type_id)

    body = api.get(f"/venues/{venue}/events/{event_id}/occupancy", "bouncer").json()
    assert body["inside"] == 2, body
    assert body["unique_admitted"] == 2, body
    assert body["exits"] == 0, body


def test_exit_lowers_occupancy(api):
    """Sale una persona: `inside` baja y `free_seats` sube."""
    venue, event_id, type_id = _open_night(api)
    t1 = _enter(api, venue, event_id, type_id)
    _enter(api, venue, event_id, type_id)

    antes = api.get(f"/venues/{venue}/events/{event_id}/occupancy", "bouncer").json()
    assert antes["inside"] == 2, antes

    salida = api.post(
        f"/venues/{venue}/events/{event_id}/exit",
        "bouncer",
        {"raw_token": t1["raw_token"], "door_id": "puerta-norte"},
    )
    assert salida.status_code == 200, salida.text
    assert salida.json()["code"] == "EXITED", salida.text
    assert salida.json()["exited"] is True, salida.text

    despues = api.get(f"/venues/{venue}/events/{event_id}/occupancy", "bouncer").json()
    assert despues["inside"] == 1, despues
    assert despues["exits"] == 1, despues
    assert despues["free_seats"] == antes["free_seats"] + 1, despues


def test_exit_twice_is_idempotent_over_http(api):
    """El operador repite el escaneo de salida: no descuenta dos veces."""
    venue, event_id, type_id = _open_night(api)
    t1 = _enter(api, venue, event_id, type_id)

    primera = api.post(
        f"/venues/{venue}/events/{event_id}/exit", "bouncer",
        {"raw_token": t1["raw_token"]},
    )
    segunda = api.post(
        f"/venues/{venue}/events/{event_id}/exit", "bouncer",
        {"raw_token": t1["raw_token"]},
    )

    assert primera.json()["code"] == "EXITED", primera.text
    assert segunda.json()["code"] == "ALREADY_OUTSIDE", segunda.text
    assert segunda.json()["exited"] is False, segunda.text

    body = api.get(f"/venues/{venue}/events/{event_id}/occupancy", "bouncer").json()
    assert body["inside"] == 0, body
    assert body["exits"] == 1, body


def test_exit_of_unknown_token_is_not_an_error_500(api):
    """Un QR de otra noche: responde un código, no revienta."""
    venue, event_id, _ = _open_night(api)

    res = api.post(
        f"/venues/{venue}/events/{event_id}/exit", "bouncer",
        {"raw_token": "tokenquenoexiste123"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["exited"] is False, res.text


def test_occupancy_denied_outside_the_venue(api):
    """Aislamiento por venue: otra venue no ve ni toca esta ocupación.

    `outsider` es admin de venue_b, así que TIENE rol: el rechazo tiene que
    venir del guard de pertenencia del evento (404), no del de roles.
    """
    venue, event_id, type_id = _open_night(api)
    _enter(api, venue, event_id, type_id)
    otra = api.world["venue_b"]

    assert api.get(f"/venues/{otra}/events/{event_id}/occupancy", "outsider").status_code == 404
    assert api.post(
        f"/venues/{otra}/events/{event_id}/exit", "outsider",
        {"raw_token": "x" * 20},
    ).status_code == 404


def test_occupancy_denied_without_role(api):
    """Sin rol en la venue no se ve la ocupación (el guard de roles manda)."""
    venue, event_id, _ = _open_night(api)
    # `promoter2` no tiene ningún evento asignado pero sí rol en venue_a,
    # así que aquí se usa un usuario de otra venue sobre ESTA venue.
    res = api.get(
        f"/venues/{venue}/events/{event_id}/occupancy",
        "outsider",
    )
    # admin de venue_b sobre venue_a: sin rol aquí -> 403.
    assert res.status_code == 403, res.text
