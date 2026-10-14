"""CTA de lista de espera en el detalle publico (E2, cierre del ciclo DICE).

El detalle publico decide que accion ofrece al fan: "comprar" mientras haya
lugar, "entrar a la lista de espera" cuando el evento esta AGOTADO. El gate
debe ser EXACTAMENTE el mismo que el de `join_waitlist` (la lista solo existe
sin boletas): si el CTA y el join no coinciden, el fan ve un boton que la API
rechaza con 409 — el peor de los mundos (promete y luego niega).

Aqui se prueba el contrato end-to-end: el flag `sold_out` del detalle y que el
join acepte justo en ese punto (y rechace uno antes).
"""
import uuid



def _tag() -> str:
    return uuid.uuid4().hex[:8]


def _sold_out_event(api, *, capacity=2, quantity=2, emit=2):
    """Evento publicado y futuro, agotado: todas las boletas emitidas."""
    venue = api.world["venue_a"]
    tag = _tag()
    ev = api.create_event(
        "admin", venue, name=f"Agotado {tag}", capacity=capacity, location=tag
    )
    t = api.add_type(
        "admin", venue, ev["id"],
        name="General", price_cents=5000000, quantity=quantity, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    for i in range(emit):
        api.emit("admin", venue, ev["id"], ticket_type_id=t["id"], allocation_id=None)
    return venue, ev["id"], t["id"]


def _detail(api_client, event_id):
    res = api_client.get(f"/public/events/{event_id}")  # sin Authorization
    assert res.status_code == 200, res.text
    return res.json()


def test_detail_marks_sold_out_when_quota_is_gone(api, api_client):
    _, event_id, _ = _sold_out_event(api)
    assert _detail(api_client, event_id)["sold_out"] is True


def test_detail_not_sold_out_while_seats_remain(api, api_client):
    venue = api.world["venue_a"]
    tag = _tag()
    ev = api.create_event(
        "admin", venue, name=f"Con lugar {tag}", capacity=100, location=tag
    )
    t = api.add_type(
        "admin", venue, ev["id"],
        name="General", price_cents=5000000, quantity=50, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    api.emit("admin", venue, ev["id"], ticket_type_id=t["id"], allocation_id=None)
    assert _detail(api_client, ev["id"])["sold_out"] is False


def test_sold_out_flag_is_the_exact_waitlist_gate(api, api_client):
    """El CTA y el join no pueden discrepar: agotado -> join 201; con lugar -> 409."""
    _, event_id, _ = _sold_out_event(api)
    assert _detail(api_client, event_id)["sold_out"] is True
    joined = api_client.post(
        f"/waitlist/{event_id}/join",
        json={"name": "Fan Fila", "phone": f"57300{uuid.uuid4().hex[:7]}"},
    )
    assert joined.status_code == 201, joined.text

    venue = api.world["venue_a"]
    ev = api.create_event(
        "admin", venue, name=f"Abierto {_tag()}", capacity=100
    )
    api.add_type(
        "admin", venue, ev["id"],
        name="General", price_cents=5000000, quantity=50, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    assert _detail(api_client, ev["id"])["sold_out"] is False
    blocked = api_client.post(
        f"/waitlist/{ev['id']}/join",
        json={"name": "Fan Fila", "phone": f"57300{uuid.uuid4().hex[:7]}"},
    )
    assert blocked.status_code == 409, blocked.text


def test_sold_out_uses_event_capacity_not_only_quota(api, api_client):
    """Aforo menor que el cupo de localidades: el evento se agota con el aforo."""
    venue = api.world["venue_a"]
    tag = _tag()
    ev = api.create_event(
        "admin", venue, name=f"Aforo {tag}", capacity=1, location=tag
    )
    t = api.add_type(
        "admin", venue, ev["id"],
        name="General", price_cents=5000000, quantity=50, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])
    api.emit("admin", venue, ev["id"], ticket_type_id=t["id"], allocation_id=None)
    # quota (50) > aforo (1): el min() manda y el evento esta agotado con 1 venta.
    assert _detail(api_client, ev["id"])["sold_out"] is True


def test_no_types_event_follows_the_join_gate(api, api_client):
    """Sin localidades el cupo es 0 y el gate del join tambien lo trata como
    lleno (LEAST(0, capacity)=0, active=0 no es < 0): el flag no puede mentir
    y decir "comprable" cuando no hay nada que comprar."""
    venue = api.world["venue_a"]
    tag = _tag()
    ev = api.create_event("admin", venue, name=f"Sin tipos {tag}", capacity=50)
    api.publish("admin", venue, ev["id"])
    assert _detail(api_client, ev["id"])["sold_out"] is True
    joined = api_client.post(
        f"/waitlist/{ev['id']}/join",
        json={"name": "Fan Fila", "phone": f"57300{uuid.uuid4().hex[:7]}"},
    )
    assert joined.status_code == 201, joined.text
