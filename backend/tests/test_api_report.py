"""Tests del reporte del evento: recaudo vivo y desglose por tipo.

El recaudo viene del snapshot de precio de cada boleta (price_cents_snapshot):
inmutable aunque el admin edite el tipo después. Solo cuentan las boletas
activas — anular o reembolsar reduce el recaudo.
"""
from datetime import datetime, timedelta, timezone


def _future_offset() -> str:
    """starts_at futuro en ISO (los eventos nuevos se crean en draft/published)."""
    return (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()


def _ticket_id_by_token(db, raw_token: str) -> int:
    row = db.execute(
        "SELECT id FROM tickets WHERE token_hash=encode(digest(%s,'sha256'),'hex')",
        (raw_token,),
    ).fetchone()
    assert row is not None
    return row["id"]

def test_report_revenue_and_by_type(api):
    """Recaudo = suma de snapshots activos; by_type respeta cantidades."""
    venue = api.world["venue_a"]

    # Evento publicado con dos tipos: pago ($300) y cortesía.
    ev = api.create_event("admin", venue, name="Reporte Event", starts_at=_future_offset())
    t_paid = api.add_type(
        "admin", venue, ev["id"],
        name="Pago", price_cents=30000, quantity=50, is_courtesy=False,
    )
    t_free = api.add_type(
        "admin", venue, ev["id"],
        name="Cortesia", price_cents=0, quantity=10, is_courtesy=True,
    )
    api.publish("admin", venue, ev["id"])

    # Venta directa: 2 boletas de pago (sin cupo de promotor).
    for i in range(2):
        res = api.post(
            f"/venues/{venue}/events/{ev['id']}/tickets",
            "admin",
            {
                "ticket_type_id": t_paid["id"],
                "customer_name": f"Pagador {i}",
                "customer_phone": "3001234567",
            },
        )
        assert res.status_code == 201, res.text

    # 1 cortesía vía cupo de promotor.
    alloc = api.set_allocation(
        "admin", venue, ev["id"],
        ticket_type_id=t_free["id"],
        promoter_id=api.world["promoter"]["id"],
        capacity=5,
    )
    api.emit(
        "promoter", venue, ev["id"],
        ticket_type_id=t_free["id"],
        allocation_id=alloc["id"],
        customer_name="Invitado cortesia",
    )

    res = api.get(f"/venues/{venue}/events/{ev['id']}/report", "admin")
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["revenue_cents"] == 60000  # 2 x $300
    assert body["issued"] == 3

    by_id = {t["name"]: t for t in body["by_type"]}
    assert by_id["Pago"]["issued"] == 2
    assert by_id["Pago"]["revenue_cents"] == 60000
    assert by_id["Pago"]["quantity"] == 50
    assert by_id["Cortesia"]["issued"] == 1
    assert by_id["Cortesia"]["revenue_cents"] == 0  # cortesía no recauda


def test_report_revenue_drops_on_void(api, db):
    """Anular una boleta reduce el recaudo (dinero vivo, no histórico)."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Void Revenue", starts_at=_future_offset())
    t = api.add_type(
        "admin", venue, ev["id"],
        name="Pago", price_cents=50000, quantity=50, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])

    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/tickets",
        "admin",
        {
            "ticket_type_id": t["id"],
            "customer_name": "Uno",
            "customer_phone": "3001234567",
        },
    )
    assert res.status_code == 201, res.text
    token1 = res.json()["raw_token"]
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/tickets",
        "admin",
        {
            "ticket_type_id": t["id"],
            "customer_name": "Dos",
            "customer_phone": "3001234567",
        },
    )
    assert res.status_code == 201, res.text

    res = api.get(f"/venues/{venue}/events/{ev['id']}/report", "admin")
    assert res.json()["revenue_cents"] == 100000

    # Anular la primera: -50000
    tid = _ticket_id_by_token(db, token1)
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/tickets/{tid}/void",
        "admin",
        {"reason": "error de digitación"},
    )
    assert res.status_code == 200, res.text

    res = api.get(f"/venues/{venue}/events/{ev['id']}/report", "admin")
    body = res.json()
    assert body["revenue_cents"] == 50000
    assert body["voided"] == 1
    assert body["issued"] == 1


def test_report_revenue_uses_snapshot_not_current_price(api):
    """Editar el precio del tipo NO cambia el recaudo ya emitido."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Snapshot Event", starts_at=_future_offset())
    t = api.add_type(
        "admin", venue, ev["id"],
        name="Pago", price_cents=10000, quantity=50, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])

    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/tickets",
        "admin",
        {
            "ticket_type_id": t["id"],
            "customer_name": "Uno",
            "customer_phone": "3001234567",
        },
    )
    assert res.status_code == 201, res.text

    # El admin sube el precio del tipo a $500 después de emitir.
    res = api.patch(
        api.type_url(venue, ev["id"], t["id"]),
        "admin",
        {"price_cents": 50000},
    )
    assert res.status_code == 200, res.text

    res = api.get(f"/venues/{venue}/events/{ev['id']}/report", "admin")
    body = res.json()
    assert body["revenue_cents"] == 10000  # snapshot, no precio nuevo
    by_type = {x["name"]: x for x in body["by_type"]}
    assert by_type["Pago"]["price_cents"] == 50000  # precio vigente del tipo
    assert by_type["Pago"]["revenue_cents"] == 10000  # pero recaudo del snapshot


def test_report_by_type_includes_empty_types(api):
    """Tipos sin boletas aparecen con issued=0 (inventario completo visible)."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Empty Type", starts_at=_future_offset())
    api.add_type(
        "admin", venue, ev["id"],
        name="VIP", price_cents=80000, quantity=10, is_courtesy=False,
    )
    api.publish("admin", venue, ev["id"])

    res = api.get(f"/venues/{venue}/events/{ev['id']}/report", "admin")
    body = res.json()
    assert len(body["by_type"]) == 1
    assert body["by_type"][0]["name"] == "VIP"
    assert body["by_type"][0]["issued"] == 0
    assert body["by_type"][0]["revenue_cents"] == 0
    assert body["revenue_cents"] == 0


def test_report_forbidden_for_other_venue(api):
    """Aislamiento multi-tenant del reporte."""
    ev = api.create_event("admin", api.world["venue_a"], name="Iso", starts_at=_future_offset())
    res = api.get(
        f"/venues/{api.world['venue_b']}/events/{ev['id']}/report", "outsider"
    )
    # El outsider es admin de la venue B, pero el evento no existe en esa venue.
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Salud de puerta en el reporte (duplicados / rechazos)
# ---------------------------------------------------------------------------
def _open_night(api, name: str) -> tuple[int, int]:
    """Evento publicado y EN PUERTA, con la ventana del QR ya abierta."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=name)
    api.publish("admin", venue, ev["id"])
    # El QR se activa 60 min antes de starts_at (default): al mover el evento
    # al pasado, un canje es GRANTED y no NOT_ACTIVE.
    api.run_sql(
        f"UPDATE events SET starts_at = now() - interval '1 hour' WHERE id = {ev['id']}"
    )
    res = api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    assert res.status_code == 200, res.text
    return venue, ev["id"]


def test_report_door_health_counts_duplicates_and_rejections(api):
    """El admin ve, en vivo, cuántas boletas se reescanearon y cuántas se negaron.

    Un pico de duplicados es el síntoma de un QR reenviado/clonado: tiene que
    estar en el reporte del evento, no solo en el CSV del día siguiente.
    """
    venue, event_id = _open_night(api, "Salud de puerta")
    tipo = api.add_type(
        "admin", venue, event_id,
        name="General", price_cents=0, quantity=5, is_courtesy=True,
    )
    ticket = api.emit(
        "admin", venue, event_id, ticket_type_id=tipo["id"], allocation_id=None,
    )

    # Primer escaneo: ingresa. Segundo: duplicado (QR reenviado). Tercero:
    # token que no existe (rechazo).
    first = api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": ticket["raw_token"]},
    )
    assert first.status_code == 200 and first.json()["redeemed"] is True, first.text
    dup = api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": ticket["raw_token"]},
    )
    assert dup.status_code == 200, dup.text
    bad = api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": "no-existe-este-token"},
    )
    assert bad.status_code in (200, 404), bad.text

    body = api.get(f"/venues/{venue}/events/{event_id}/report", "admin").json()
    assert body["door_duplicates"] == 1
    assert body["door_rejected"] == 1


def test_report_door_per_porter_counts_forced_entry_as_granted(api):
    """Un ingreso forzado por staff es ENTRADA, no rechazo — tambien por portero.

    El desglose por portero usaba `outcome <> 'granted'` como "rechazado", asi
    que un `granted_forced` (staff dejo pasar fuera de la ventana del QR) se
    contaba como fallo: la suma por portero no cuadraba con el total del evento
    y el bouncer que mas trabaja aparecia con rechazos que nunca hizo.
    """
    venue, event_id = _open_night(api, "Forzado por portero")
    tipo = api.add_type(
        "admin", venue, event_id,
        name="General", price_cents=0, quantity=5, is_courtesy=True,
    )
    ticket = api.emit(
        "admin", venue, event_id, ticket_type_id=tipo["id"], allocation_id=None,
    )
    # Fuera de la ventana el canje es NOT_ACTIVE; el admin lo fuerza y queda
    # auditado como granted_forced (mismo camino que la puerta real).
    api.run_sql(
        f"UPDATE events SET starts_at = now() + interval '10 days' WHERE id = {event_id}"
    )
    forced = api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "admin",
        {"raw_token": ticket["raw_token"], "force": True},
    )
    assert forced.status_code == 200, forced.text

    body = api.get(f"/venues/{venue}/events/{event_id}/summary", "admin").json()
    door = body["door"]
    # Dos filas: el escaneo NOT_ACTIVE (rechazo real, queda auditado) y el
    # canje forzado. El forzado es ENTRADA; el rechazo previo sigue contando.
    assert door["granted"] == 1, door
    assert door["failed"] == 1, door
    # La suma del desglose por portero tiene que dar el total del evento. Con
    # el bug, `granted_forced` caia en `failed`: la suma por portero daba 2
    # rechazos donde el evento contaba 1 (y 0 ingresos donde hubo 1).
    assert sum(p["granted"] for p in door["scanned_by"]) == door["granted"]
    assert sum(p["failed"] for p in door["scanned_by"]) == door["failed"]
    assert sum(p["total"] for p in door["scanned_by"]) == door["total"]


def test_report_door_health_not_leaked_to_promoter(api):
    """El promotor NO ve la salud de puerta: es dato operativo del negocio."""
    venue, event_id = _open_night(api, "Salud privada")
    tipo = api.add_type(
        "admin", venue, event_id,
        name="General", price_cents=0, quantity=5, is_courtesy=True,
    )
    ticket = api.emit(
        "admin", venue, event_id, ticket_type_id=tipo["id"], allocation_id=None,
    )
    api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": ticket["raw_token"]},
    )
    api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": ticket["raw_token"]},
    )

    body = api.get(f"/venues/{venue}/events/{event_id}/report", "promoter").json()
    assert body["door_duplicates"] == 0
    assert body["door_rejected"] == 0


def test_report_door_pulse_buckets_ingresos_por_franja(api):
    """El ritmo de puerta: ingresos agrupados en franjas de 10 min.

    El total dice CÓMO VA la puerta; el ritmo dice si está FLUYENDO o
    atascada. Es la señal que el admin necesita para reaccionar mientras el
    evento pasa (abrir otro lector), no al día siguiente.
    """
    venue, event_id = _open_night(api, "Ritmo de puerta")
    tipo = api.add_type(
        "admin", venue, event_id,
        name="General", price_cents=0, quantity=20, is_courtesy=True,
    )

    # 3 boletas canjeadas + 1 duplicado (que NO es ingreso: no infla el ritmo).
    tokens = []
    for i in range(3):
        t = api.emit(
            "admin", venue, event_id,
            ticket_type_id=tipo["id"], allocation_id=None,
            customer_name=f"Asistente {i}",
        )
        tokens.append(t["raw_token"])
    for tok in tokens:
        res = api.post(
            f"/venues/{venue}/events/{event_id}/redeem",
            "bouncer", {"raw_token": tok},
        )
        assert res.status_code == 200 and res.json()["redeemed"] is True, res.text
    api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": tokens[0]},
    )

    body = api.get(f"/venues/{venue}/events/{event_id}/report", "admin").json()
    pulse = body["door_pulse"]
    assert pulse, "hay ingresos: el ritmo no puede venir vacío"
    # Todos los escaneos cayeron en la misma franja (el test corre en ms), así
    # que la serie es una sola barra. El bucket NO es 0: _open_night arranca el
    # evento 1 h atrás y la puerta abre ~60 min después del inicio.
    assert len(pulse) == 1
    assert pulse[0]["count"] == 3  # el duplicado no cuenta
    assert sum(p["count"] for p in pulse) == 3
    # La hora local del evento viaja formateada (HH:MM), sin husos en el front.
    assert len(pulse[0]["label"]) == 5 and pulse[0]["label"][2] == ":"


def test_report_door_pulse_rellena_franjas_vacias(api):
    """Una franja SIN ingresos es el dato (la puerta se atoró): no se salta.

    Si solo devolviéramos las franjas con datos, el eje del gráfico mentiría:
    dos franjas contiguas se verían igual que dos separadas por media hora.
    """
    venue, event_id = _open_night(api, "Ritmo con hueco")
    tipo = api.add_type(
        "admin", venue, event_id,
        name="General", price_cents=0, quantity=20, is_courtesy=True,
    )
    t1 = api.emit(
        "admin", venue, event_id,
        ticket_type_id=tipo["id"], allocation_id=None,
    )
    t2 = api.emit(
        "admin", venue, event_id,
        ticket_type_id=tipo["id"], allocation_id=None,
        customer_name="Tarde",
    )
    api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": t1["raw_token"]},
    )
    # El segundo ingreso llega 25 min DESPUÉS del primero (hueco de 2 franjas
    # vacías en medio). No se mueve el primero hacia atrás: cruzaría `starts_at`
    # y la fila quedaría fuera de la serie.
    api.run_sql(
        f"UPDATE redemptions SET scanned_at = scanned_at + interval '25 minutes' "
        f"WHERE event_id = {event_id}"
    )
    api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": t2["raw_token"]},
    )

    pulse = api.get(
        f"/venues/{venue}/events/{event_id}/report", "admin"
    ).json()["door_pulse"]
    counts = [p["count"] for p in pulse]
    # Los dos ingresos en los extremos, con AL MENOS una franja vacía en medio:
    # el hueco se rellena (si se saltara, la serie tendría largo 2 y el eje
    # mentiría). El número exacto de huecos depende de la fase de los 10 min.
    assert counts[0] == 1 and counts[-1] == 1
    assert counts.count(0) >= 1
    assert sum(counts) == 2
    # Sin saltos: una franja por cada 10 min entre la primera y la última.
    assert len(pulse) == pulse[-1]["bucket"] - pulse[0]["bucket"] + 1


def test_report_door_pulse_sin_ingresos_es_vacio(api):
    """Sin ningún ingreso no hay serie: el front dibuja su propio vacío."""
    venue, event_id = _open_night(api, "Puerta sin abrir")
    api.add_type(
        "admin", venue, event_id,
        name="General", price_cents=0, quantity=5, is_courtesy=True,
    )
    body = api.get(f"/venues/{venue}/events/{event_id}/report", "admin").json()
    assert body["door_pulse"] == []


def test_report_door_pulse_not_leaked_to_promoter(api):
    """El ritmo de puerta es operativo del negocio: el promotor no lo ve."""
    venue, event_id = _open_night(api, "Ritmo privado")
    tipo = api.add_type(
        "admin", venue, event_id,
        name="General", price_cents=0, quantity=5, is_courtesy=True,
    )
    t = api.emit(
        "admin", venue, event_id,
        ticket_type_id=tipo["id"], allocation_id=None,
    )
    api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer", {"raw_token": t["raw_token"]},
    )
    body = api.get(f"/venues/{venue}/events/{event_id}/report", "promoter").json()
    assert body["door_pulse"] == []

