"""Preguntas post-compra, boletas virtuales, autocorrección y SEO (mig 075)."""
import json
import uuid
from datetime import datetime, timedelta, timezone

from app.core.fan_access import create_fan_access_token


def _tag() -> str:
    return uuid.uuid4().hex[:8]


def _published_event(api, **extra):
    venue = api.world["venue_a"]
    event = api.create_event("admin", venue, name=f"Evento {_tag()}", capacity=50, **extra)
    api.publish("admin", venue, event["id"])
    return venue, event["id"]


def _question(api, venue, event_id, **over):
    payload = {
        "prompt": "¿Qué nivel de experiencia tienes?",
        "kind": "select",
        "options": ["Principiante", "Intermedio", "Avanzado"],
        "required": True,
    }
    payload.update(over)
    res = api.post(f"/venues/{venue}/events/{event_id}/questions", "admin", payload)
    assert res.status_code == 201, res.text
    return res.json()


def test_admin_creates_questions_and_virtual_ticket(api):
    venue = api.world["venue_a"]
    event = api.create_event("admin", venue, name=f"Prep {_tag()}", capacity=30)

    q = _question(api, venue, event["id"])
    assert q["options"] == ["Principiante", "Intermedio", "Avanzado"]
    assert q["answer_count"] == 0

    rows = api.get(f"/venues/{venue}/events/{event['id']}/questions", "admin").json()
    assert [r["id"] for r in rows] == [q["id"]]

    off = api.patch(
        f"/venues/{venue}/events/{event['id']}/questions/{q['id']}",
        "admin",
        {"is_active": False},
    )
    assert off.status_code == 200 and off.json()["is_active"] is False

    ttype = api.add_type(
        "admin", venue, event["id"], name="Virtual", price_cents=1500000,
        quantity=20, is_courtesy=False, is_virtual=True,
    )
    assert ttype["is_virtual"] is True
    listed = api.types("admin", venue, event["id"])
    assert listed[0]["is_virtual"] is True

    deleted = api.delete(
        f"/venues/{venue}/events/{event['id']}/questions/{q['id']}", "admin"
    )
    assert deleted.status_code == 200


def test_fan_answers_question_with_credential(api):
    venue, event_id = _published_event(api)
    q = _question(api, venue, event_id)
    ttype = api.add_type(
        "admin", venue, event_id, name="General", price_cents=1000000,
        quantity=10, is_courtesy=False,
    )
    ticket = api.emit("admin", venue, event_id, ticket_type_id=ttype["id"], allocation_id=None)
    credential = {"raw_token": ticket["raw_token"]}

    res = api.client.post(
        f"/public/my-tickets/{ticket['ticket_id']}/questions", json=credential
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["questions"][0]["prompt"] == q["prompt"]
    assert body["questions"][0]["can_answer"] is True

    saved = api.client.put(
        f"/public/my-tickets/{ticket['ticket_id']}/questions/{q['id']}",
        json={**credential, "answer": "Intermedio"},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["answer"] == "Intermedio"

    bad = api.client.put(
        f"/public/my-tickets/{ticket['ticket_id']}/questions/{q['id']}",
        json={**credential, "answer": "Otro"},
    )
    assert bad.status_code == 422

    # Otra boleta no puede leer ni responder las preguntas de esta.
    other = api.emit(
        "admin", venue, event_id, ticket_type_id=ttype["id"], allocation_id=None,
        customer_name="Otra persona", customer_phone="3115550000",
    )
    assert api.client.post(
        f"/public/my-tickets/{ticket['ticket_id']}/questions",
        json={"raw_token": other["raw_token"]},
    ).status_code == 404


def test_virtual_stream_only_inside_window(api):
    venue, event_id = _published_event(api)
    now = datetime.now(timezone.utc)
    patched = api.patch(
        f"/venues/{venue}/events/{event_id}",
        "admin",
        {
            "stream_url": "https://example.com/enty",
            "stream_starts_at": (now + timedelta(hours=2)).isoformat(),
            "stream_ends_at": (now + timedelta(hours=3)).isoformat(),
            "stream_instructions": "Entra con tu nombre.",
        },
    )
    assert patched.status_code == 200, patched.text

    ttype = api.add_type(
        "admin", venue, event_id, name="Virtual", price_cents=1000000,
        quantity=10, is_courtesy=False, is_virtual=True,
    )
    ticket = api.emit("admin", venue, event_id, ticket_type_id=ttype["id"], allocation_id=None)
    credential = {"raw_token": ticket["raw_token"]}

    early = api.client.post(
        f"/public/my-tickets/{ticket['ticket_id']}/stream", json=credential
    )
    assert early.status_code == 200, early.text
    assert early.json()["active"] is False
    assert early.json()["url"] is None

    # La ficha pública anuncia horario, nunca la URL.
    detail = api.client.get(f"/public/events/{event_id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["stream"]["starts_at"].startswith((now + timedelta(hours=2)).isoformat()[:13])
    assert "example.com/enty" not in detail.text
    assert detail.json()["ticket_types"][0]["is_virtual"] is True

    api.patch(
        f"/venues/{venue}/events/{event_id}",
        "admin",
        {
            "stream_starts_at": (now - timedelta(minutes=5)).isoformat(),
            "stream_ends_at": (now + timedelta(hours=1)).isoformat(),
        },
    )
    live = api.client.post(
        f"/public/my-tickets/{ticket['ticket_id']}/stream", json=credential
    )
    assert live.status_code == 200, live.text
    assert live.json()["active"] is True
    assert live.json()["url"] == "https://example.com/enty"
    assert live.json()["instructions"] == "Entra con tu nombre."

    page = api.client.get(f"/public/tickets/{ticket['raw_token']}")
    assert page.status_code == 200, page.text
    assert "Ver transmisión" in page.text
    assert "https://example.com/enty" in page.text
    assert f"/api/public/tickets/{ticket['raw_token']}/image.jpg" not in page.text


def test_fan_corrects_name_and_phone_without_reissuing(api):
    venue, event_id = _published_event(api)
    ttype = api.add_type(
        "admin", venue, event_id, name="General", price_cents=1000000,
        quantity=10, is_courtesy=False,
    )
    ticket = api.emit(
        "admin", venue, event_id, ticket_type_id=ttype["id"], allocation_id=None,
        customer_name="Nombre Mal",
    )
    credential = {"raw_token": ticket["raw_token"]}
    before_hash = api.run_sql(
        f"SELECT token_hash FROM tickets WHERE id={ticket['ticket_id']}"
    )

    name_only = api.client.post(
        f"/public/my-tickets/{ticket['ticket_id']}/contact",
        json={**credential, "customer_name": "Nombre Bien"},
    )
    assert name_only.status_code == 200, name_only.text
    assert name_only.json()["changed"] == ["nombre"]

    no_proof = api.client.post(
        f"/public/my-tickets/{ticket['ticket_id']}/contact",
        json={**credential, "customer_phone": "3109998877"},
    )
    assert no_proof.status_code == 403

    corrected = api.client.post(
        f"/public/my-tickets/{ticket['ticket_id']}/contact",
        json={
            **credential,
            "customer_name": "Nombre Bien",
            "customer_phone": "3109998877",
            "current_contact": "3001234567",
        },
    )
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["customer_phone"] == "3109998877"
    assert corrected.json()["ownership_unchanged"] is True
    assert api.run_sql(
        f"SELECT token_hash FROM tickets WHERE id={ticket['ticket_id']}"
    ) == before_hash


def test_share_and_sitemap_expose_public_event_metadata(api, api_client):
    venue = api.world["venue_a"]
    desc = "Una noche de salsa en vivo con tres orquestas."
    event = api.create_event(
        "admin", venue, name=f"Salsa {_tag()}", capacity=80, description=desc,
        ends_at=(datetime.now(timezone.utc) + timedelta(hours=31)).isoformat(),
    )
    api.add_type(
        "admin", venue, event["id"], name="General", price_cents=5000000,
        quantity=40, is_courtesy=False,
    )
    api.publish("admin", venue, event["id"])

    share = api_client.get(f"/public/share/evento/{event['id']}")
    assert share.status_code == 200, share.text
    assert '<meta name="robots" content="index, follow" />' in share.text
    assert desc in share.text
    data = json.loads(
        share.text.split('<script type="application/ld+json">', 1)[1].split("</script>", 1)[0]
    )
    assert data["description"] == desc
    assert data["endDate"].startswith("20")
    assert data["offers"]["availability"].endswith("InStock")

    sitemap = api_client.get("/sitemap.xml")
    assert sitemap.status_code == 200
    assert f"/evento/{event['id']}" in sitemap.text

    draft = api.create_event("admin", venue, name=f"Borrador {_tag()}", capacity=10)
    assert f"/evento/{draft['id']}" not in api_client.get("/sitemap.xml").text

    robots = api_client.get("/robots.txt")
    assert robots.status_code == 200
    assert "Sitemap:" in robots.text and "/sitemap.xml" in robots.text


def test_fan_link_still_lists_new_fields(api):
    venue, event_id = _published_event(api)
    _question(api, venue, event_id)
    ttype = api.add_type(
        "admin", venue, event_id, name="Virtual", price_cents=1000000,
        quantity=10, is_courtesy=False, is_virtual=True,
    )
    ticket = api.emit(
        "admin", venue, event_id, ticket_type_id=ttype["id"], allocation_id=None,
        customer_name="Ana",
    )
    token = create_fan_access_token("3001234567")
    res = api.client.post("/public/my-tickets/access", json={"token": token})
    assert res.status_code == 200, res.text
    row = res.json()["tickets"][0]
    assert row["ticket_id"] == ticket["ticket_id"]
    assert row["customer_name"] == "Ana"
    assert row["is_virtual"] is True
    assert row["has_questions"] is True
    assert "stream_message" in row
