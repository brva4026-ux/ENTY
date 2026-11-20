"""Sala de espera virtual: caudal, pases y portero del checkout.

Lo que se prueba, en orden de importancia:

1. La tanda se respeta bajo concurrencia (8 sesiones, tanda de 2 -> 2).
2. Sin pase vigente NO se crea el cobro (si esto falla, la sala es decorativa).
3. El pase no se quema al abrir el checkout: solo lo gasta la compra.
4. La sala apagada no cambia nada del checkout actual.
"""
import uuid


def _tag() -> str:
    return uuid.uuid4().hex[:8]


def _session() -> str:
    return uuid.uuid4().hex + uuid.uuid4().hex


def _room_event(api, *, batch=2, pass_minutes=10, enabled=True):
    """Evento publicado con la sala configurada."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Sala {_tag()}", capacity=100)
    tipo = api.add_type(
        "admin", venue, ev["id"], name="General", price_cents=5000,
        quantity=100, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    api.run_sql(
        f"UPDATE events SET waiting_room_enabled = {str(enabled).lower()}, "
        f"waiting_room_batch = {batch}, waiting_room_pass_minutes = {pass_minutes} "
        f"WHERE id = {ev['id']}"
    )
    return venue, ev["id"], tipo["id"]


def _join(api, event_id, session):
    return api.client.post(
        f"/public/events/{event_id}/waiting-room/join",
        json=        {"session_token": session},
    )


def test_first_batch_is_admitted_with_pass(api):
    """Con lugar en la tanda, el fan entra directo y recibe su pase."""
    _, event_id, _ = _room_event(api, batch=5)

    res = _join(api, event_id, _session())
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "admitted", body
    assert body["pass_token"], body
    assert body["expires_at"], body


def test_over_batch_goes_to_queue_without_pass(api):
    """Pasada la tanda, el fan espera: no recibe pase y ve su posición."""
    _, event_id, _ = _room_event(api, batch=2)
    _join(api, event_id, _session())
    _join(api, event_id, _session())

    tercero = _join(api, event_id, _session()).json()
    assert tercero["status"] == "waiting", tercero
    assert tercero["pass_token"] is None, tercero
    assert tercero["queue_position"] == 0, tercero


def test_queue_position_counts_people_ahead(api):
    """El segundo en la fila tiene a uno delante, no cero."""
    _, event_id, _ = _room_event(api, batch=1)
    _join(api, event_id, _session())  # este entra

    primero = _join(api, event_id, _session()).json()
    segundo = _join(api, event_id, _session()).json()
    assert primero["queue_position"] == 0, primero
    assert segundo["queue_position"] == 1, segundo


def test_join_is_idempotent_for_same_session(api):
    """Recargar la página no pierde el lugar ni crea filas duplicadas."""
    _, event_id, _ = _room_event(api, batch=1)
    _join(api, event_id, _session())

    session = _session()
    primera = _join(api, event_id, session).json()
    segunda = _join(api, event_id, session).json()

    assert primera["status"] == segunda["status"] == "waiting"
    assert primera["queue_position"] == segunda["queue_position"] == 0
    filas = api.run_sql(
        f"SELECT count(*) FROM event_waiting_room "
        f"WHERE event_id = {event_id} AND session_hash = '{api.digest(session)}'"
    )
    assert filas == 1, filas


def test_status_endpoint_does_not_hand_out_passes(api):
    """El polling solo informa: no admite a nadie por preguntar."""
    _, event_id, _ = _room_event(api, batch=1)
    _join(api, event_id, _session())
    session = _session()
    _join(api, event_id, session)

    res = api.client.get(
        f"/public/events/{event_id}/waiting-room/status?session_token={session}"
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "waiting", res.text


def test_expired_pass_sends_the_fan_back_to_the_queue(api):
    """Un pase vencido no sirve: el fan vuelve a la fila al reintentar."""
    _, event_id, _ = _room_event(api, batch=1, pass_minutes=10)
    session = _session()
    primero = _join(api, event_id, session).json()
    assert primero["status"] == "admitted"

    # El pase vence mientras el fan piensa.
    api.run_sql(
        f"UPDATE event_waiting_room "
        f"SET pass_expires_at = now() - interval '1 minute' "
        f"WHERE event_id = {event_id} AND session_hash = '{api.digest(session)}'"
    )

    # Otro ocupa la tanda, así que al volver no le toca.
    _join(api, event_id, _session())

    de_nuevo = _join(api, event_id, session).json()
    assert de_nuevo["status"] == "waiting", de_nuevo
    assert de_nuevo["pass_token"] is None, de_nuevo


def test_checkout_rejects_without_pass(api):
    """Sin pase no se crea el cobro: la sala no es decorativa."""
    _, event_id, type_id = _room_event(api, batch=1)

    res = api.client.post(
        f"/public/events/{event_id}/checkout",
        json=        {
            "ticket_type_id": type_id,
            "customer_name": "Sin Pase",
            "customer_phone": "3001234567",
        },
    )
    assert res.status_code == 429, res.text
    assert "sala de espera" in res.text.lower(), res.text


def test_checkout_rejects_expired_pass(api):
    """Un pase vencido tampoco pasa el portero."""
    _, event_id, type_id = _room_event(api, batch=1)
    session = _session()
    pase = _join(api, event_id, session).json()["pass_token"]
    api.run_sql(
        f"UPDATE event_waiting_room "
        f"SET pass_expires_at = now() - interval '1 minute' "
        f"WHERE event_id = {event_id}"
    )

    res = api.client.post(
        f"/public/events/{event_id}/checkout",
        json=        {
            "ticket_type_id": type_id,
            "customer_name": "Tarde",
            "customer_phone": "3001234567",
            "waiting_pass": pase,
        },
    )
    assert res.status_code == 429, res.text


def test_disabled_room_does_not_ask_for_a_pass(api):
    """Sala apagada: el checkout se comporta exactamente como antes."""
    _, event_id, type_id = _room_event(api, enabled=False)

    res = _join(api, event_id, _session())
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "admitted", res.text

    # El portero no se interpone: el rechazo (si lo hay) es por Wompi
    # deshabilitado, nunca por la sala.
    res = api.client.post(
        f"/public/events/{event_id}/checkout",
        json=        {
            "ticket_type_id": type_id,
            "customer_name": "Sin Sala",
            "customer_phone": "3001234567",
        },
    )
    assert res.status_code != 429, res.text


def test_require_waiting_pass_accepts_a_valid_pass(api):
    """El portero deja pasar el pase bueno (sin consumirlo)."""
    _, event_id, _ = _room_event(api, batch=1)
    session = _session()
    pase = _join(api, event_id, session).json()["pass_token"]

    # Dos veces: abrir el checkout no quema el pase.
    for _ in range(2):
        api.run_sql(f"SELECT require_waiting_pass({event_id}, '{pase}')")

    estado = api.run_sql(
        f"SELECT status FROM event_waiting_room WHERE event_id = {event_id}"
    )
    assert estado == "admitted", estado


def test_consume_waiting_pass_is_idempotent(api):
    """Consumir dos veces no revienta ni cambia el estado a otra cosa."""
    _, event_id, _ = _room_event(api, batch=1)
    session = _session()
    pase = _join(api, event_id, session).json()["pass_token"]

    api.run_sql(f"SELECT consume_waiting_pass({event_id}, '{pase}')")
    api.run_sql(f"SELECT consume_waiting_pass({event_id}, '{pase}')")

    estado = api.run_sql(
        f"SELECT status FROM event_waiting_room WHERE event_id = {event_id}"
    )
    assert estado == "used", estado
    usado = api.run_sql(
        f"SELECT used_at IS NOT NULL FROM event_waiting_room WHERE event_id = {event_id}"
    )
    assert usado is True, usado


def test_batch_is_respected_under_concurrency(api):
    """8 sesiones peleando por una tanda de 2: entran exactamente 2.

    Es la prueba central de la sala. Sin el lock por evento, el conteo y la
    admisión se intercalan y entran más de los que la tanda permite.
    """
    from concurrent.futures import ThreadPoolExecutor

    _, event_id, _ = _room_event(api, batch=2)
    sesiones = [_session() for _ in range(8)]

    def entrar(session):
        return _join(api, event_id, session).json()["status"]

    with ThreadPoolExecutor(max_workers=8) as pool:
        resultados = list(pool.map(entrar, sesiones))

    assert resultados.count("admitted") == 2, resultados
    assert resultados.count("waiting") == 6, resultados

    fila = api.run_sql(
        f"SELECT count(*) FROM event_waiting_room "
        f"WHERE event_id = {event_id} AND status = 'admitted'"
    )
    assert fila == 2, fila


def test_two_events_have_independent_queues(api):
    """Una tanda llena en un evento no bloquea la sala de otro."""
    _, ev1, _ = _room_event(api, batch=1)
    _, ev2, _ = _room_event(api, batch=1)

    assert _join(api, ev1, _session()).json()["status"] == "admitted"
    # ev1 ya está lleno, pero ev2 tiene su propia tanda libre.
    assert _join(api, ev2, _session()).json()["status"] == "admitted"
