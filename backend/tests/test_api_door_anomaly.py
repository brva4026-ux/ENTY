"""Aviso al admin cuando la puerta ve una rafaga de duplicados (mig 026).

El admin ya VE los duplicados (reporte + franja), pero solo si esta mirando.
El trigger los convierte en notificacion in-app: 3+ 'already_redeemed' del
MISMO ticket en 5 minutos = firma de un QR reenviado. Se avisa al CRUZAR el
umbral, una sola vez por rafaga (no en cada escaneo extra).

Estos tests ejercen el trigger a traves de la API publica de canje, igual que
el resto de la suite: el contrato es lo que ve el admin en su campana.
"""


def _open_night(api, name: str) -> tuple[int, int]:
    """Evento publicado y EN PUERTA, con la ventana del QR ya abierta."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=name)
    api.publish("admin", venue, ev["id"])
    api.run_sql(
        f"UPDATE events SET starts_at = now() - interval '1 hour' WHERE id = {ev['id']}"
    )
    res = api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    assert res.status_code == 200, res.text
    return venue, ev["id"]


def _scan(api, venue: int, event_id: int, token: str):
    return api.post(
        f"/venues/{venue}/events/{event_id}/redeem",
        "bouncer",
        {"raw_token": token},
    )


def _door_anomalies(api, who: str) -> list[dict]:
    res = api.get("/notifications", who)
    assert res.status_code == 200, res.text
    return [n for n in res.json() if n["kind"] == "door_anomaly"]


def _emit_courtesy(api, venue: int, event_id: int) -> dict:
    tipo = api.add_type(
        "admin", venue, event_id,
        name="General", price_cents=0, quantity=5, is_courtesy=True,
    )
    return api.emit(
        "admin", venue, event_id, ticket_type_id=tipo["id"], allocation_id=None,
    )


def test_door_anomaly_alerts_admin_on_burst(api):
    """1 ingreso + 3 duplicados cruzan el umbral: el admin recibe UN aviso."""
    venue, event_id = _open_night(api, "Rafaga de duplicados")
    ticket = _emit_courtesy(api, venue, event_id)
    token = ticket["raw_token"]

    assert _door_anomalies(api, "admin") == []

    first = _scan(api, venue, event_id, token)
    assert first.status_code == 200 and first.json()["redeemed"] is True, first.text

    # Duplicado 1 y 2: aun por debajo del umbral (3).
    assert _scan(api, venue, event_id, token).status_code == 200
    assert _scan(api, venue, event_id, token).status_code == 200
    assert _door_anomalies(api, "admin") == []

    # Duplicado 3: cruza el umbral -> un aviso, con link al panel.
    assert _scan(api, venue, event_id, token).status_code == 200
    alerts = _door_anomalies(api, "admin")
    assert len(alerts) == 1, alerts
    assert alerts[0]["title"] == "Duplicados en puerta"
    assert alerts[0]["link"] == "/admin"
    assert "3 veces" in alerts[0]["body"]

    # Duplicado 4: la rafaga ya avisada NO vuelve a sonar.
    assert _scan(api, venue, event_id, token).status_code == 200
    assert len(_door_anomalies(api, "admin")) == 1


def test_door_anomaly_does_not_alert_below_threshold(api):
    """Un duplicado suelto es normal (dos personas escaneando): sin aviso."""
    venue, event_id = _open_night(api, "Duplicado suelto")
    ticket = _emit_courtesy(api, venue, event_id)
    token = ticket["raw_token"]

    assert _scan(api, venue, event_id, token).status_code == 200
    assert _scan(api, venue, event_id, token).status_code == 200

    assert _door_anomalies(api, "admin") == []


def test_door_anomaly_not_leaked_to_promoter(api):
    """El aviso es operativo del negocio: el promotor no lo recibe."""
    venue, event_id = _open_night(api, "Rafaga privada")
    ticket = _emit_courtesy(api, venue, event_id)
    token = ticket["raw_token"]

    _scan(api, venue, event_id, token)
    for _ in range(3):
        _scan(api, venue, event_id, token)

    assert len(_door_anomalies(api, "admin")) == 1
    assert _door_anomalies(api, "promoter") == []
