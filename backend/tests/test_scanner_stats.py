"""Contadores del turno de puerta (tanda 3).

Cubre dos cosas que estaban sin cobertura — y una de ellas era un bug vivo:

- `GET /events/mine` ("Mis noches" del promotor): la ruta vivia ANIDADA dentro
  de `list_events`, despues del `return out`, asi que el decorador nunca se
  ejecutaba y el endpoint no existia. La peticion terminaba matcheando
  `PATCH /events/{event_id}` con `event_id="mine"` y respondia 405. El frontend
  lo tragaba en silencio, asi que "Mis noches" nunca aparecia. Estos tests son
  los que faltaban para que no vuelva a pasar.
- `GET /events/{id}/scanner-stats`: cuantos ingresos hizo ESTE escaner, no el
  total del evento. En una noche con dos puertas, el total no dice quien
  trabajo; el dato sale de `redemptions.scanned_by_user_id`.

Sin seed el world no existe y estos tests se saltan (convencion del repo).
"""
import uuid


def _tag() -> str:
    return uuid.uuid4().hex[:8]


def _open_night(api, name="Noche de contadores"):
    """Evento propio, publicado, EN PUERTA y con la ventana del QR abierta."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"{name} {_tag()}")
    api.publish("admin", venue, ev["id"])
    # La ventana del QR se abre 60 min antes de starts_at (default): mover el
    # evento al pasado es lo que hace que un canje sea GRANTED y no NOT_ACTIVE.
    api.run_sql(
        f"UPDATE events SET starts_at = now() - interval '1 hour' WHERE id = {ev['id']}"
    )
    res = api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    assert res.status_code == 200, res.text
    return venue, ev["id"]


# ---------------------------------------------------------------------------
# MIS NOCHES: la ruta que estaba muerta
# ---------------------------------------------------------------------------
def test_mis_noches_is_registered_not_405(api):
    """Regresion exacta del bug: respondia 405 (lo capturaba /events/{id})."""
    venue = api.world["venue_a"]
    res = api.get(f"/venues/{venue}/events/mine", "admin")
    assert res.status_code == 200, res.text


def test_mis_noches_lists_only_assigned_events(api):
    venue, event_id = _open_night(api, "Noche asignada")
    otra = api.create_event("admin", venue, name=f"Otra noche {_tag()}")

    # Sin asignaciones la lista es vacia, no un error.
    assert api.get(f"/venues/{venue}/events/mine", "promoter").json() == []

    asignado = api.post(
        f"/venues/{venue}/events/{event_id}/staff",
        "admin",
        {"user_id": api.world["promoter"]["id"], "role": "promotor"},
    )
    assert asignado.status_code == 201, asignado.text

    res = api.get(f"/venues/{venue}/events/mine", "promoter")
    assert res.status_code == 200, res.text
    ids = [e["id"] for e in res.json()]
    assert ids == [event_id]
    assert otra["id"] not in ids


def test_mis_noches_denies_bouncer(api):
    """El bouncer no vende: no tiene "mis noches"."""
    venue = api.world["venue_a"]
    assert api.get(f"/venues/{venue}/events/mine", "bouncer").status_code == 403


# ---------------------------------------------------------------------------
# El contador del escaner
# ---------------------------------------------------------------------------
def _emit_and_redeem(api, venue, event_id):
    tipo = api.add_type(
        "admin",
        venue,
        event_id,
        name="General",
        price_cents=1000,
        quantity=5,
        is_courtesy=False,
    )
    ticket = api.emit(
        "admin",
        venue,
        event_id,
        ticket_type_id=tipo["id"],
        allocation_id=None,
    )
    canje = api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer",
        {"raw_token": ticket["raw_token"]},
    )
    assert canje.status_code == 200, canje.text
    assert canje.json()["redeemed"] is True, canje.text
    return ticket


def test_scanner_stats_counts_only_my_scans(api):
    """El contador es por ESCANER, no el total del evento."""
    venue, event_id = _open_night(api)
    _emit_and_redeem(api, venue, event_id)

    mio = api.get(f"/venues/{venue}/events/{event_id}/scanner-stats", "bouncer")
    assert mio.status_code == 200, mio.text
    assert mio.json()["granted"] == 1
    assert mio.json()["already_redeemed"] == 0

    # El admin no escaneo nada: su contador es 0 aunque el evento tenga 1.
    ajeno = api.get(f"/venues/{venue}/events/{event_id}/scanner-stats", "admin")
    assert ajeno.status_code == 200, ajeno.text
    assert ajeno.json()["granted"] == 0


def test_scanner_stats_separates_reuse_from_granted(api):
    """Un reuso no es un ingreso: se cuenta aparte."""
    venue, event_id = _open_night(api)
    ticket = _emit_and_redeem(api, venue, event_id)

    api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer",
        {"raw_token": ticket["raw_token"]},
    )

    stats = api.get(
        f"/venues/{venue}/events/{event_id}/scanner-stats", "bouncer"
    ).json()
    assert stats["granted"] == 1
    assert stats["already_redeemed"] == 1


def test_scanner_stats_hides_other_venues_event(api):
    venue, event_id = _open_night(api)
    otra = api.world["venue_b"]
    res = api.get(f"/venues/{otra}/events/{event_id}/scanner-stats", "outsider")
    assert res.status_code == 404, res.text
