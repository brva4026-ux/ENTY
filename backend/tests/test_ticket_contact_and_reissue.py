"""Corrección de contacto (mig 015) y reemisión (mig 004) desde la API.

- PATCH /contact corrige nombre/teléfono de boletas VIGENTES con auditoría;
  el promotor solo toca las suyas; una usada/anulada no se edita.
- POST /reissue rota el token: el QR viejo muere en el acto y el nuevo sirve;
  mismo mapa de permisos que el PATCH.

Los permisos son espejo a propósito (ambos pueden redirigir un QR): si alguien
logra corregir la boleta ajena, también podría reemitirla.
"""


def _scenario_with_ticket(api):
    """Evento publicado + boleta emitida por el promotor (su cupo)."""
    s = api.scenario()
    ticket = api.emit(
        "promoter", s["venue"], s["event"],
        ticket_type_id=s["type"], allocation_id=s["allocation"],
        customer_name="Nombre Mal Escrito",
    )
    return s, ticket


def test_admin_corrects_phone_with_audit(api, db):
    s, ticket = _scenario_with_ticket(api)
    url = f"{api.event_url(s['venue'], s['event'])}/tickets/{ticket['ticket_id']}/contact"

    res = api.patch(url, "admin", {
        "customer_phone": "3112223344",
        "reason": "Quedo mal escrito",
    })
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["customer_phone"] == "3112223344"
    assert body["customer_name"] == "Nombre Mal Escrito"  # intacto

    # La auditoría quedó: quién, valores viejos, motivo.
    row = db.execute(
        """
        SELECT e.email, old_phone, new_phone, reason
          FROM ticket_contact_edits ce
          JOIN users e ON e.id = ce.edited_by_user_id
         WHERE ce.ticket_id = %s
        """,
        (ticket["ticket_id"],),
    ).fetchone()
    assert row is not None
    assert row["email"] == api.world["admin"]["email"]
    assert row["old_phone"] == "3001234567"
    assert row["new_phone"] == "3112223344"
    assert row["reason"] == "Quedo mal escrito"


def test_contact_history_endpoint(api):
    """GET /contact-edits: el historial visible desde la UI (quien y cuando)."""
    s, ticket = _scenario_with_ticket(api)
    base = f"{api.event_url(s['venue'], s['event'])}/tickets/{ticket['ticket_id']}"

    # Sin correcciones previas: lista vacia (no error).
    res = api.get(f"{base}/contact-edits", "promoter")
    assert res.status_code == 200, res.text
    assert res.json() == []

    # Dos correcciones consecutivas quedan ambas, la mas nueva primero.
    api.patch(f"{base}/contact", "promoter", {"customer_phone": "3111111111"})
    api.patch(f"{base}/contact", "admin", {"customer_name": "Nombre Bien", "reason": "reo"})
    res = api.get(f"{base}/contact-edits", "promoter")
    assert res.status_code == 200
    rows = res.json()
    assert len(rows) == 2
    assert rows[0]["edited_by_name"].startswith("Usuario admin")
    assert rows[0]["old_name"] == "Nombre Mal Escrito"
    assert rows[0]["new_name"] == "Nombre Bien"
    assert rows[1]["edited_by_name"].startswith("Usuario promotor")
    assert rows[1]["old_phone"] == "3001234567"
    assert rows[1]["new_phone"] == "3111111111"
    assert rows[1]["new_name"] == rows[1]["old_name"]  # no cambio en esa edicion

    # Otro promotor no ve el historial ajeno; staff si.
    res = api.get(f"{base}/contact-edits", "promoter2")
    assert res.status_code == 403
    res = api.get(f"{base}/contact-edits", "admin")
    assert res.status_code == 200


def test_promoter_corrects_own_but_not_others(api):
    s, ticket = _scenario_with_ticket(api)
    url = f"{api.event_url(s['venue'], s['event'])}/tickets/{ticket['ticket_id']}/contact"

    # El dueño corrige su propia boleta (solo el nombre).
    res = api.patch(url, "promoter", {"customer_name": "Nombre Correcto"})
    assert res.status_code == 200, res.text
    assert res.json()["customer_name"] == "Nombre Correcto"

    # Otro promotor NO puede tocarla (podría redirigir el QR ajeno).
    res = api.patch(url, "promoter2", {"customer_phone": "3000000000"})
    assert res.status_code == 403
    # El bouncer tampoco (solo escanea).
    res = api.patch(url, "bouncer", {"customer_phone": "3000000000"})
    assert res.status_code in (401, 403)


def test_cannot_edit_redeemed_or_voided(api, db):
    s, ticket = _scenario_with_ticket(api)
    url = f"{api.event_url(s['venue'], s['event'])}/tickets/{ticket['ticket_id']}/contact"

    db.execute(
        "UPDATE tickets SET status = 'redeemed' WHERE id = %s",
        (ticket["ticket_id"],),
    )
    res = api.patch(url, "admin", {"customer_phone": "3112223344"})
    assert res.status_code == 409
    assert "vigentes" in res.json()["detail"].lower() or "usadas" in res.json()["detail"].lower()


def test_invalid_phone_and_empty_body_rejected(api):
    s, ticket = _scenario_with_ticket(api)
    url = f"{api.event_url(s['venue'], s['event'])}/tickets/{ticket['ticket_id']}/contact"

    res = api.patch(url, "admin", {"customer_phone": "abc"})
    assert res.status_code == 400

    # Sin nombre ni teléfono no hay nada que hacer.
    res = api.patch(url, "admin", {"reason": "solo motivo"})
    assert res.status_code == 400


def test_reissue_rotates_token_and_kills_old_qr(api):
    s, ticket = _scenario_with_ticket(api)
    old_token = ticket["raw_token"]
    url = f"{api.event_url(s['venue'], s['event'])}/tickets/{ticket['ticket_id']}/reissue"

    # El dueño (promotor) reemite: mismo ticket, token NUEVO.
    res = api.post(url, "promoter", {"reason": "WhatsApp perdido"})
    assert res.status_code == 200, res.text
    new_token = res.json()["raw_token"]
    assert new_token != old_token
    assert res.json()["ticket_id"] == ticket["ticket_id"]

    # El QR viejo muere: el preview público ya no lo conoce.
    dead = api.client.post("/tickets/preview", json={"raw_token": old_token})
    assert dead.status_code == 404
    # El nuevo sirve.
    alive = api.client.post("/tickets/preview", json={"raw_token": new_token})
    assert alive.status_code == 200


def test_reissue_permissions_mirror_contact(api):
    s, ticket = _scenario_with_ticket(api)
    url = f"{api.event_url(s['venue'], s['event'])}/tickets/{ticket['ticket_id']}/reissue"

    # Otro promotor no; el staff sí; el bouncer no.
    res = api.post(url, "promoter2", None)
    assert res.status_code == 403
    res = api.post(url, "admin", {"reason": "desde administración"})
    assert res.status_code == 200
    res = api.post(url, "bouncer", None)
    assert res.status_code in (401, 403)


def test_reissue_redeemed_blocked(api, db):
    s, ticket = _scenario_with_ticket(api)
    db.execute(
        "UPDATE tickets SET status = 'redeemed' WHERE id = %s",
        (ticket["ticket_id"],),
    )
    url = f"{api.event_url(s['venue'], s['event'])}/tickets/{ticket['ticket_id']}/reissue"
    res = api.post(url, "admin", None)
    assert res.status_code == 409  # sería una segunda entrada gratis
