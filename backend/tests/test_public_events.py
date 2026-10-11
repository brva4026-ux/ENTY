"""Catalogo publico de eventos (`/public/events`) para la pantalla Inicio.

Es la vitrina sin sesion del fan: solo eventos con venta abierta y futuros,
con categoria inferida, precio minimo y aforo vendido. Como el endpoint es
publico, importa que no filtre datos internos y que el LIMIT no oculte el
filtro por ciudad.

Las pruebas NO vacian el catalogo (otros tests de la suite dejan eventos
publicados que no se pueden borrar por sus pagos): cada una usa nombres y una
ciudad unicos y solo afirma sobre SUS propios eventos.
"""
import uuid


def _tag() -> str:
    return uuid.uuid4().hex[:8]


def _future_show(api, venue, name, *, price_cents=None, location=None):
    """Evento publicado y futuro, con una localidad paga opcional."""
    extra = {"location": location} if location else {}
    event = api.create_event("admin", venue, name=name, capacity=100, **extra)
    if price_cents is not None:
        api.add_type(
            "admin", venue, event["id"],
            name="General", price_cents=price_cents, quantity=50, is_courtesy=False,
        )
        # Una cortesia no debe contar como precio minimo (solo localidades pagas).
        api.add_type("admin", venue, event["id"], name="Cortesia", is_courtesy=True)
    api.publish("admin", venue, event["id"])
    return event


def _by_name(body, name):
    return next(e for e in body["events"] if e["name"] == name)


def test_catalog_is_public_and_lists_open_future_shows(api, api_client):
    # Ciudad unica para no depender de la ventana global de 50 (la suite deja
    # cientos de eventos publicados): el filtro deja solo los de esta prueba.
    venue = api.world["venue_a"]
    tag = _tag()
    city = f"CiudadCatalogo{tag}"
    name = f"Neon Dreams Tour {tag}"
    _future_show(api, venue, name, price_cents=18000000, location=city)

    res = api_client.get("/public/events", params={"city": city})  # sin Authorization
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["categories"] == ["Música", "Deportes", "Teatro"]
    show = _by_name(body, name)
    assert show["price_cents"] == 18000000  # cortesia excluida del minimo
    assert show["category"] == "Música"
    assert show["venue"] and "Venue" in show["venue"]
    assert "starts_at" in show and "sold_pct" in show


def test_category_is_inferred_from_the_event_text(api, api_client):
    venue = api.world["venue_a"]
    tag = _tag()
    city = f"CiudadRama{tag}"
    sport = f"Final de Liga {tag}"
    theater = f"Obra de Teatro: Bodas de Sangre {tag}"
    _future_show(api, venue, sport, price_cents=9500000, location=city)
    _future_show(api, venue, theater, price_cents=4000000, location=city)

    body = api_client.get("/public/events", params={"city": city}).json()
    assert _by_name(body, sport)["category"] == "Deportes"
    assert _by_name(body, theater)["category"] == "Teatro"


def test_city_filter_does_not_disappear_behind_the_limit(api, api_client):
    # Ciudad unica de esta prueba: solo sus eventos la igualan. El LIMIT es de
    # 1 y hay 5 shows de otra ciudad de sobra: si el filtro se aplicara despues
    # del LIMIT, la ciudad pedida quedaria en cero.
    venue = api.world["venue_a"]
    tag = _tag()
    city = f"CiudadTest{tag}"
    other = f"OtraCiudad{tag}"
    for i in range(5):
        _future_show(api, venue, f"Show Otro {tag} {i}", price_cents=1000000, location=other)
    _future_show(api, venue, f"Show Principal {tag}", price_cents=2000000, location=city)

    body = api_client.get("/public/events", params={"city": city, "limit": 1}).json()
    assert body["count"] == 1
    assert body["events"][0]["name"] == f"Show Principal {tag}"
    assert body["city"] == city


def test_draft_and_past_events_are_not_shown(api, api_client):
    # Ciudad unica: el catalogo global (con cientos de eventos sembrados)
    # podria dejar estos fuera de la ventana de 50; filtrando por ciudad solo
    # quedan los eventos de esta prueba.
    venue = api.world["venue_a"]
    tag = _tag()
    city = f"CiudadVisible{tag}"
    visible = f"Visible {tag}"
    draft = f"Borrador invisible {tag}"
    past = f"Pasado invisible {tag}"
    _future_show(api, venue, visible, location=city)
    api.create_event("admin", venue, name=draft, capacity=50, location=city)
    past_event = _future_show(api, venue, past, price_cents=1000000, location=city)
    api.run_sql(
        f"UPDATE events SET starts_at = now() - interval '2 days' WHERE id = {past_event['id']}"
    )

    body = api_client.get("/public/events", params={"city": city}).json()
    names = [e["name"] for e in body["events"]]
    assert names == [visible]


# --- Detalle publico de un evento (`/public/events/{id}`) -----------------
#
# Pantalla "comprar boleto": el fan abre un evento del catalogo. Misma
# derivacion que el listado (categoria, precio minimo) mas la descripcion y
# las localidades. Como es publico, un evento no publicado debe responder 404
# igual que un id inexistente: no se filtra la existencia de borradores.


def test_detail_is_public_and_returns_description_and_types(api, api_client):
    venue = api.world["venue_a"]
    tag = _tag()
    name = f"Detalle Publico {tag}"
    event = _future_show(api, venue, name, price_cents=18000000)
    api.run_sql(
        f"UPDATE events SET description = 'Una noche de sintetizadores' "
        f"WHERE id = {event['id']}"
    )

    res = api_client.get(f"/public/events/{event['id']}")  # sin Authorization
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["id"] == event["id"]
    assert body["name"] == name
    assert body["description"] == "Una noche de sintetizadores"
    assert body["category"] == "Música"
    assert body["price_cents"] == 18000000  # la cortesia no baja el minimo
    # Ambas localidades viajan (la cortesia con precio 0), para pintar el
    # selector de compra.
    by_type = {t["name"]: t for t in body["ticket_types"]}
    assert by_type["General"]["price_cents"] == 18000000
    assert by_type["Cortesia"]["price_cents"] == 0
    assert body["lineup"] == []  # sin tabla de artistas: lista vacia explicita


def test_detail_404_for_draft_past_and_unknown(api, api_client):
    venue = api.world["venue_a"]
    tag = _tag()
    draft = api.create_event("admin", venue, name=f"Borrador {tag}", capacity=50)
    past = _future_show(api, venue, f"Pasado {tag}", price_cents=1000000)
    api.run_sql(
        f"UPDATE events SET starts_at = now() - interval '2 days' WHERE id = {past['id']}"
    )

    assert api_client.get(f"/public/events/{draft['id']}").status_code == 404
    assert api_client.get(f"/public/events/{past['id']}").status_code == 404
    assert api_client.get("/public/events/99999999").status_code == 404
