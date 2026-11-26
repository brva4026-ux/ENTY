"""Doce frentes nuevos (mig 072)."""
import uuid
from datetime import datetime, timedelta, timezone


def _put(api, path, who, payload):
    return api.client.put(path, headers=api.headers(who), json=payload)


def _tag():
    return uuid.uuid4().hex[:6]


def _event(api, capacity=20):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name=f"Más {_tag()}", capacity=capacity)
    api.publish("admin", venue, ev["id"])
    return venue, ev["id"]


def _type(api, venue, event, quantity=20, price=50000):
    res = api.post(
        f"/venues/{venue}/events/{event}/types",
        "admin",
        {"name": "General", "price_cents": price, "quantity": quantity,
         "is_courtesy": False},
    )
    assert res.status_code == 201, res.text
    return res.json()


def _sell(api, venue, event, type_id, name="Ana"):
    res = api.post(
        f"/venues/{venue}/events/{event}/tickets",
        "admin",
        {"ticket_type_id": type_id, "customer_name": name,
         "customer_phone": "3001234567"},
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_manual_admission_and_access_rules(api):
    venue, event = _event(api)
    tipo = _type(api, venue, event)
    ticket = _sell(api, venue, event, tipo["id"], "Camila Pérez")

    found = api.get(
        f"/venues/{venue}/events/{event}/door/lookup?q=Camila", "admin"
    )
    assert found.status_code == 200, found.text
    assert found.json()[0]["id"] == ticket["ticket_id"]

    admitted = api.post(
        f"/venues/{venue}/events/{event}/door/manual-admission",
        "admin",
        {"ticket_id": ticket["ticket_id"], "reason": "Sin batería",
         "verification": "Documento y correo confirmados"},
    )
    assert admitted.status_code == 201, admitted.text
    again = api.post(
        f"/venues/{venue}/events/{event}/door/manual-admission",
        "admin",
        {"ticket_id": ticket["ticket_id"], "reason": "Sin batería",
         "verification": "Documento"},
    )
    assert again.status_code == 409, again.text

    rules = _put(api, f"/venues/{venue}/events/{event}/access-rules", "admin",
        {"dress_code": "Elegante", "bags_policy": "Bolsos pequeños",
         "prohibited_items": ["Vidrio", "Pirotecnia"]},
    )
    assert rules.status_code == 200, rules.text
    public = api.client.get(f"/public/events/{event}/access-rules")
    assert public.json()["version"] == 1
    assert public.json()["prohibited_items"] == ["Vidrio", "Pirotecnia"]


def test_fees_and_disputes(api):
    venue, event = _event(api)
    tipo = _type(api, venue, event, price=100000)
    cfg = _put(api, f"/venues/{venue}/events/{event}/fee-config", "admin",
        {"service_fee_cents": 5000, "payment_fee_pct": 3, "tax_pct": 19,
         "show_breakdown": True},
    )
    assert cfg.status_code == 200, cfg.text
    fees = api.client.get(
        f"/public/events/{event}/fees?ticket_type_id={tipo['id']}"
    )
    assert fees.status_code == 200, fees.text
    assert fees.json()["total_cents"] > 100000

    dispute = api.post(
        f"/venues/{venue}/events/{event}/disputes", "admin",
        {"amount_cents": 100000, "reason": "Contracargo del banco",
         "due_at": (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()},
    )
    assert dispute.status_code == 201, dispute.text
    updated = api.patch(
        f"/venues/{venue}/events/{event}/disputes/{dispute.json()['id']}",
        "admin", {"status": "ganada", "notes": "Pruebas enviadas"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["status"] == "ganada"


def test_polls_and_recordings(api):
    venue, event = _event(api)
    tipo = _type(api, venue, event)
    ticket = _sell(api, venue, event, tipo["id"], "Votante")
    poll = api.post(
        f"/venues/{venue}/events/{event}/polls", "admin",
        {"question": "¿Cuál canción cierras?", "options": ["Uno", "Dos"]},
    )
    assert poll.status_code == 201, poll.text
    poll_id = poll.json()["id"]
    assert api.patch(
        f"/venues/{venue}/events/{event}/polls/{poll_id}", "admin",
        {"status": "abierta"},
    ).status_code == 200
    public = api.client.get(f"/public/events/{event}/polls")
    assert public.status_code == 200, public.text
    option_id = public.json()[0]["options"][0]["id"]
    vote = api.client.post(
        f"/public/polls/{poll_id}/vote",
        json={"ticket_token": ticket["raw_token"], "option_id": option_id},
    )
    assert vote.status_code == 200, vote.text
    repeat = api.client.post(
        f"/public/polls/{poll_id}/vote",
        json={"ticket_token": ticket["raw_token"], "option_id": option_id},
    )
    assert repeat.status_code == 409, repeat.text

    rec = api.post(
        f"/venues/{venue}/events/{event}/recordings", "admin",
        {"title": "Show completo", "url": "https://example.com/video"},
    )
    assert rec.status_code == 201, rec.text
    visible = api.client.get(
        f"/public/events/{event}/recordings?ticket_token={ticket['raw_token']}"
    )
    assert visible.status_code == 200, visible.text
    assert visible.json()[0]["title"] == "Show completo"


def test_lottery_and_rsvp(api):
    venue, event = _event(api)
    now = datetime.now(timezone.utc)
    lottery = api.post(
        f"/venues/{venue}/events/{event}/lotteries", "admin",
        {"name": "Preventa por sorteo",
         "opens_at": (now - timedelta(hours=1)).isoformat(),
         "closes_at": (now + timedelta(hours=1)).isoformat(),
         "quantity": 2, "terms": "Un cupo por persona"},
    )
    assert lottery.status_code == 201, lottery.text
    lottery_id = lottery.json()["id"]
    entry = api.client.post(
        f"/public/lotteries/{lottery_id}/enter",
        json={"name": "Sofía", "email": "sofia@example.com",
              "phone": "3000000000"},
    )
    assert entry.status_code == 201, entry.text
    drawn = api.post(
        f"/venues/{venue}/events/{event}/lotteries/{lottery_id}/draw", "admin", {}
    )
    assert drawn.status_code == 200, drawn.text
    assert len(drawn.json()["winners"]) == 1
    winner_token = drawn.json()["winners"][0]["token"]
    assert api.client.get(f"/public/lottery-winners/{winner_token}").status_code == 200
    assert api.client.post(
        f"/public/lottery-winners/{winner_token}/claim"
    ).status_code == 200

    rsvp = api.client.post(
        f"/public/events/{event}/rsvp",
        json={"name": "Gratis", "email": "free@example.com"},
    )
    assert rsvp.status_code == 201, rsvp.text
    token = rsvp.json()["token"]
    assert api.client.get(f"/public/rsvps/{token}").status_code == 200
    assert api.client.post(f"/public/rsvps/{token}/cancel").status_code == 200


def test_venue_profile_staffing_link_archive(api):
    venue, event = _event(api)
    profile = _put(api, f"/venues/{venue}/profile", "admin",
        {"stage_width_m": 8, "stage_depth_m": 5,
         "load_in_start": "14:00", "load_in_end": "18:00",
         "sound_system": "Line array", "technical_contact": "Producción"},
    )
    assert profile.status_code == 200, profile.text
    public = api.client.get(f"/public/venues/{venue}/profile")
    assert public.json()["profile"]["sound_system"] == "Line array"

    forecast = api.get(
        f"/venues/{venue}/events/{event}/staffing-forecast", "admin"
    )
    assert forecast.status_code == 200, forecast.text
    assert "hourly_plan" in forecast.json()

    check = api.post(
        f"/venues/{venue}/events/{event}/link-checks", "admin",
        {"url": "http://127.0.0.1:1/no-existe", "kind": "campana"},
    )
    assert check.status_code == 201, check.text
    assert check.json()["status"] == "fail"

    archive = _put(api, f"/venues/{venue}/events/{event}/archive", "admin",
        {"enabled": True, "headline": "Así fue",
         "summary": "La noche quedó en la memoria.",
         "photos": ["https://example.com/foto.jpg"]},
    )
    assert archive.status_code == 200, archive.text
    pub = api.client.get(f"/public/events/{event}/archive")
    assert pub.status_code == 200, pub.text
    assert pub.json()["headline"] == "Así fue"
