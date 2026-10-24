"""Puerta y promotores a nivel VENUE, sin abrir un evento.

Estas dos vistas responden preguntas que el panel no podía contestar sin
elegir antes una noche: "¿qué está pasando en mi puerta ahora?" y "¿quién va
cumpliendo su cupo este mes?".

Los agregados de puerta son de las noches EN VIVO (`status='live'`), no del
mes: la puerta es operación de esta noche, no caja histórica. El cupo de
promotores sale de `promoter_allocations`, que es lo que `top_promoters` del
overview no miraba.
"""
from datetime import datetime, timedelta, timezone


def _open_night(api, name: str, capacity: int = 100) -> tuple[int, int]:
    """Evento publicado y EN PUERTA (status live), con el QR ya abierto."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=name, capacity=capacity)
    api.publish("admin", venue, ev["id"])
    api.run_sql(
        f"UPDATE events SET starts_at = now() - interval '1 hour' WHERE id = {ev['id']}"
    )
    res = api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    assert res.status_code == 200, res.text
    return venue, ev["id"]


def _scan(api, venue: int, event_id: int, token: str, who: str = "bouncer"):
    return api.post(
        f"/venues/{venue}/events/{event_id}/redeem", who, {"raw_token": token}
    )


def _courtesy(api, venue: int, event_id: int, *, qty: int = 5, allocation_id=None,
              who: str = "admin", name: str | None = None) -> dict:
    tipo = api.add_type(
        who, venue, event_id,
        name=name or f"General {qty}", price_cents=0, quantity=qty, is_courtesy=True,
    )
    return api.emit(
        who, venue, event_id, ticket_type_id=tipo["id"], allocation_id=allocation_id,
    )


def test_venue_door_without_live_events_is_empty(api):
    """Sin noches en vivo la puerta no inventa cifras: todo en cero."""
    venue = api.world["venue_a"]
    res = api.get(f"/venues/{venue}/door", "admin")
    assert res.status_code == 200, res.text
    d = res.json()
    assert d["live_events"] == 0
    assert d["live_capacity"] == 0
    assert d["live_issued"] == 0
    assert d["live_redeemed"] == 0
    assert d["duplicates"] == 0
    assert d["rejected"] == 0
    assert d["last_scan_at"] is None
    assert d["events"] == []


def test_venue_door_counts_live_night(api):
    """Una noche en vivo: aforo, emitidas, ingresos y último escaneo."""
    venue, event_id = _open_night(api, "Noche en vivo", capacity=80)
    t1 = _courtesy(api, venue, event_id, qty=5)
    t2 = _courtesy(api, venue, event_id, qty=5, name="VIP")

    # Un ingreso real y un duplicado del mismo QR.
    assert _scan(api, venue, event_id, t1["raw_token"]).json()["redeemed"] is True
    _scan(api, venue, event_id, t2["raw_token"])
    _scan(api, venue, event_id, t2["raw_token"])

    res = api.get(f"/venues/{venue}/door", "admin")
    assert res.status_code == 200, res.text
    d = res.json()
    assert d["live_events"] == 1
    assert d["live_capacity"] == 80
    assert d["live_issued"] == 2
    assert d["live_redeemed"] == 2
    # El segundo ticket se escaneó dos veces: una granted, una already_redeemed.
    assert d["duplicates"] == 1
    assert d["rejected"] == 0
    assert d["last_scan_at"] is not None
    assert [e["event_id"] for e in d["events"]] == [event_id]
    assert d["events"][0]["status"] == "live"
    assert d["events"][0]["capacity"] == 80


def test_venue_door_ignores_non_live_events(api):
    """Un evento publicado pero no abierto no entra en los agregados de puerta,
    pero SÍ aparece en la lista de noches (está por abrir)."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Solo publicado", capacity=50)
    api.publish("admin", venue, ev["id"])
    _courtesy(api, venue, ev["id"], qty=3)

    d = api.get(f"/venues/{venue}/door", "admin").json()
    assert d["live_events"] == 0
    assert d["live_issued"] == 0
    # La lista sí lo incluye: es una noche con puerta por abrir.
    assert [e["event_id"] for e in d["events"]] == [ev["id"]]
    assert d["events"][0]["status"] == "published"
    assert d["events"][0]["issued"] == 1


def test_venue_door_rejects_not_found_scans(api):
    """Un QR que no existe cuenta como rechazado, no como duplicado."""
    venue, event_id = _open_night(api, "Rechazos")
    _courtesy(api, venue, event_id, qty=2)

    _scan(api, venue, event_id, "token-que-no-existe")

    d = api.get(f"/venues/{venue}/door", "admin").json()
    assert d["rejected"] == 1
    assert d["duplicates"] == 0


def test_venue_door_forbidden_for_bouncer_and_promoter(api):
    """La puerta del venue es de admin: un bouncer no ve la operación global."""
    venue = api.world["venue_a"]
    for who in ("bouncer", "promoter"):
        res = api.get(f"/venues/{venue}/door", who)
        assert res.status_code == 403, f"{who} debería recibir 403, dio {res.status_code}"


def test_venue_door_rhythm_is_a_gap_filled_half_hour_series(api):
    """El ritmo son franjas de 30 min con ceros incluidos.

    Los huecos vuelven como 0 a propósito: la gráfica debe dibujar el silencio
    entre tandas, no saltárselo. Solo cuentan los escaneos `granted`.
    """
    venue, event_id = _open_night(api, "Ritmo", capacity=50)
    t1 = _courtesy(api, venue, event_id, qty=4)
    t2 = _courtesy(api, venue, event_id, qty=4, name="VIP")

    assert _scan(api, venue, event_id, t1["raw_token"]).json()["redeemed"] is True
    assert _scan(api, venue, event_id, t2["raw_token"]).json()["redeemed"] is True
    # Un duplicado: no debe sumar al ritmo (no es alguien que entró).
    _scan(api, venue, event_id, t2["raw_token"])

    d = api.get(f"/venues/{venue}/door", "admin").json()
    rhythm = d["rhythm"]
    assert len(rhythm) >= 2, "la serie debe cubrir varias franjas"
    # Franjas consecutivas de 30 min exactos, sin saltos.
    for a, b in zip(rhythm, rhythm[1:]):
        delta = datetime.fromisoformat(b["at"]) - datetime.fromisoformat(a["at"])
        assert delta == timedelta(minutes=30), (a["at"], b["at"])
    # Los 2 ingresos reales están en la serie; el duplicado no.
    assert sum(s["n"] for s in rhythm) == 2


def test_venue_door_rhythm_and_scans_empty_without_live_night(api):
    """Sin noche en vivo no hay ritmo ni cola: no se inventan series."""
    venue = api.world["venue_a"]
    d = api.get(f"/venues/{venue}/door", "admin").json()
    assert d["rhythm"] == []
    assert d["recent_scans"] == []


def test_venue_door_recent_scans_are_newest_first_and_scoped(api):
    """La cola trae los últimos escaneos, más reciente primero, y solo de ESTE
    venue: la puerta de un negocio no puede mostrar la de otro."""
    venue, event_id = _open_night(api, "Cola", capacity=50)
    t1 = _courtesy(api, venue, event_id, qty=3)
    t2 = _courtesy(api, venue, event_id, qty=3, name="VIP")
    _scan(api, venue, event_id, t1["raw_token"])
    _scan(api, venue, event_id, t2["raw_token"])
    _scan(api, venue, event_id, "token-inexistente")

    d = api.get(f"/venues/{venue}/door", "admin").json()
    scans = d["recent_scans"]
    assert len(scans) == 3
    # Más reciente primero.
    ats = [datetime.fromisoformat(s["scanned_at"]) for s in scans]
    assert ats == sorted(ats, reverse=True)
    assert scans[0]["outcome"] == "not_found"
    assert {s["outcome"] for s in scans} == {"granted", "not_found"}
    # El nombre del invitado viaja (mismo criterio que /redemptions) pero el
    # token/hash NO.
    assert all("token" not in k and "hash" not in k for s in scans for k in s)

    # Otro venue del mismo mundo no ve estos escaneos (su propio admin sí
    # puede consultar su puerta, y está vacía).
    other = api.world["venue_b"]
    d2 = api.get(f"/venues/{other}/door", "outsider").json()
    assert d2["recent_scans"] == []


def test_venue_promoters_advance_against_capacity(api):
    """El cupo asignado da el avance: 3 de 10 = 30%."""
    venue = api.world["venue_a"]
    promoter = api.world["promoter"]["id"]
    ev = api.create_event("admin", venue, name="Cupo")
    tipo = api.add_type(
        "admin", venue, ev["id"], name="Cortesia", price_cents=0,
        quantity=20, is_courtesy=True,
    )
    api.publish("admin", venue, ev["id"])
    alloc = api.set_allocation(
        "admin", venue, ev["id"], ticket_type_id=tipo["id"],
        promoter_id=promoter, capacity=10,
    )
    for i in range(3):
        api.emit(
            "promoter", venue, ev["id"], ticket_type_id=tipo["id"],
            allocation_id=alloc["id"], customer_name=f"Asistente {i}",
        )

    res = api.get(f"/venues/{venue}/promoters", "admin")
    assert res.status_code == 200, res.text
    p = res.json()["promoters"]
    fila = next(x for x in p if x["promoter_id"] == promoter)
    assert fila["capacity"] == 10
    assert fila["issued"] == 3
    assert fila["advance_pct"] == 30.0
    assert fila["has_courtesy"] is True


def test_venue_promoters_archived_allocation_loses_capacity_but_keeps_tickets(api):
    """Un cupo archivado deja de contar como aforo, pero las boletas siguen ahí.

    Es el caso real de "movió boletas sin cupo vigente": el admin archiva el
    cupo (tiene boletas, no se borra) y el promotor queda con issued > 0 y
    capacity 0. El avance debe ser 0, no 100: sin cupo no hay meta contra la
    que medir, y mostrar "cumplido" mentiría.
    """
    venue = api.world["venue_a"]
    promoter = api.world["promoter"]["id"]
    ev = api.create_event("admin", venue, name="Cupo archivado")
    tipo = api.add_type(
        "admin", venue, ev["id"], name="Cortesia", price_cents=0,
        quantity=20, is_courtesy=True,
    )
    api.publish("admin", venue, ev["id"])
    alloc = api.set_allocation(
        "admin", venue, ev["id"], ticket_type_id=tipo["id"],
        promoter_id=promoter, capacity=10,
    )
    api.emit(
        "promoter", venue, ev["id"], ticket_type_id=tipo["id"],
        allocation_id=alloc["id"],
    )
    # Con el cupo vigente, el avance es 1/10 = 10%.
    p = api.get(f"/venues/{venue}/promoters", "admin").json()["promoters"]
    fila = next(x for x in p if x["promoter_id"] == promoter)
    assert fila["capacity"] == 10 and fila["issued"] == 1
    assert fila["advance_pct"] == 10.0

    # Archivar el cupo: la boleta sigue viva, el aforo deja de contar.
    res = api.delete(f"/venues/{venue}/events/{ev['id']}/allocations/{alloc['id']}", "admin")
    assert res.status_code == 200, res.text

    p = api.get(f"/venues/{venue}/promoters", "admin").json()["promoters"]
    fila = next(x for x in p if x["promoter_id"] == promoter)
    assert fila["issued"] == 1
    assert fila["capacity"] == 0
    assert fila["advance_pct"] == 0.0


def test_venue_promoters_excludes_other_venues(api):
    """El cupo y las boletas de otra venue no se mezclan."""
    venue = api.world["venue_a"]
    otra = api.world["venue_b"]
    ajeno = api.world["outsider"]["id"]
    ev_b = api.create_event("outsider", otra, name="Otra venue")
    tipo = api.add_type(
        "outsider", otra, ev_b["id"], name="Cortesia", price_cents=0,
        quantity=20, is_courtesy=True,
    )
    api.publish("outsider", otra, ev_b["id"])
    alloc = api.set_allocation(
        "outsider", otra, ev_b["id"], ticket_type_id=tipo["id"],
        promoter_id=ajeno, capacity=7,
    )
    api.emit(
        "outsider", otra, ev_b["id"], ticket_type_id=tipo["id"],
        allocation_id=alloc["id"],
    )

    p = api.get(f"/venues/{venue}/promoters", "admin").json()["promoters"]
    assert all(x["promoter_id"] != ajeno for x in p)


def test_venue_promoters_forbidden_for_promoter(api):
    """Un promotor no ve la tabla de comisiones de sus colegas."""
    venue = api.world["venue_a"]
    res = api.get(f"/venues/{venue}/promoters", "promoter")
    assert res.status_code == 403, res.text


def test_venue_promoters_month_param_validates(api):
    """Un mes mal formado es 400, no un 500."""
    venue = api.world["venue_a"]
    assert api.get(f"/venues/{venue}/promoters?month=2026-13", "admin").status_code == 400
    assert api.get(f"/venues/{venue}/promoters?month=basura", "admin").status_code == 400
