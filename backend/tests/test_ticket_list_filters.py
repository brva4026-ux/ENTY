"""Listado de boletas paginado con filtros (y su export CSV).

El contrato nuevo: {total, items[]} con ?status/&type_id/&q/&limit/&offset y
?format=csv para el export completo filtrado (mismos permisos).
"""
import csv
import io


def _setup_event_with_tickets(api):
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Listado Filtrable")
    general = api.add_type("admin", venue, ev["id"], name="General", price_cents=5000000, quantity=50, is_courtesy=False)
    api.publish("admin", venue, ev["id"])

    for name in ("Ana García", "Luis Pérez", "Ana Luiza"):
        res = api.post(
            f"/venues/{venue}/events/{ev['id']}/tickets",
            "admin",
            {
                "ticket_type_id": general["id"],
                "customer_name": name,
                "customer_phone": "3001112233",
            },
        )
        assert res.status_code == 201, res.text
    return venue, ev["id"], general["id"]


def test_list_returns_total_and_items(api):
    venue, ev, _ = _setup_event_with_tickets(api)
    res = api.client.get(
        f"/venues/{venue}/events/{ev}/tickets", headers=api.headers("admin")
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total"] == 3
    assert len(body["items"]) == 3


def test_filter_by_q_matches_name_substring(api):
    venue, ev, _ = _setup_event_with_tickets(api)
    res = api.client.get(
        f"/venues/{venue}/events/{ev}/tickets?q=Ana", headers=api.headers("admin")
    )
    body = res.json()
    assert body["total"] == 2
    assert {i["customer_name"] for i in body["items"]} == {"Ana García", "Ana Luiza"}


def test_filter_by_status(api):
    venue, ev, _ = _setup_event_with_tickets(api)
    tickets = api.client.get(
        f"/venues/{venue}/events/{ev}/tickets", headers=api.headers("admin")
    ).json()["items"]
    # La anulacion no es un PATCH de estado: es POST .../void con motivo
    # (auditoria obligatoria, mig 002/019).
    res = api.client.post(
        f"/venues/{venue}/events/{ev}/tickets/{tickets[0]['id']}/void",
        headers=api.headers("admin"),
        json={"reason": "test"},
    )
    assert res.status_code == 200, res.text
    body = api.client.get(
        f"/venues/{venue}/events/{ev}/tickets?status=voided", headers=api.headers("admin")
    ).json()
    assert body["total"] == 1
    assert body["items"][0]["status"] == "voided"


def test_pagination_limit_offset(api):
    venue, ev, _ = _setup_event_with_tickets(api)
    r1 = api.client.get(
        f"/venues/{venue}/events/{ev}/tickets?limit=2&offset=0", headers=api.headers("admin")
    ).json()
    r2 = api.client.get(
        f"/venues/{venue}/events/{ev}/tickets?limit=2&offset=2", headers=api.headers("admin")
    ).json()
    assert len(r1["items"]) == 2
    assert len(r2["items"]) == 1
    assert r1["total"] == 3
    assert not ({i["id"] for i in r1["items"]} & {i["id"] for i in r2["items"]})


def test_invalid_status_rejected(api):
    venue, ev, _ = _setup_event_with_tickets(api)
    res = api.client.get(
        f"/venues/{venue}/events/{ev}/tickets?status=purple", headers=api.headers("admin")
    )
    assert res.status_code == 422


def test_csv_export_respects_filters(api):
    venue, ev, _ = _setup_event_with_tickets(api)
    res = api.client.get(
        f"/venues/{venue}/events/{ev}/tickets?format=csv&q=Ana",
        headers=api.headers("admin"),
    )
    assert res.status_code == 200
    assert "text/csv" in res.headers["content-type"]
    rows = list(csv.reader(io.StringIO(res.text.lstrip("﻿"))))
    assert rows[0][1] == "asistente"
    names = [r[1] for r in rows[1:] if r]
    assert set(names) == {"Ana García", "Ana Luiza"}


def test_promoter_total_only_counts_own(api):
    """El TOTAL también respeta el corte por promotor, no solo los items."""
    venue = api.world["venue_a"]
    ev = api.create_event("admin", venue, name="Corte Promotor")
    cortesia = api.add_type("admin", venue, ev["id"], name="Cortesia")
    api.publish("admin", venue, ev["id"])

    # El admin emite 2 boletas de venta directa (sin cupo).
    for name in ("Directa Uno", "Directa Dos"):
        api.post(
            f"/venues/{venue}/events/{ev['id']}/tickets",
            "admin",
            {"ticket_type_id": cortesia["id"], "customer_name": name},
        )
    # El promotor emite 1 con su cupo (asignación creada por fixture del world
    # solo si existe; si no, esta boleta no existe y el corte es trivial).
    alloc = api.client.get(
        f"/venues/{venue}/events/{ev['id']}/allocations", headers=api.headers("admin")
    ).json()
    if isinstance(alloc, list) and alloc:
        api.post(
            f"/venues/{venue}/events/{ev['id']}/tickets",
            "promoter",
            {"ticket_type_id": cortesia["id"], "customer_name": "De Promo", "allocation_id": alloc[0]["id"]},
        )

    ev_id = ev["id"]
    res = api.client.get(
        f"/venues/{venue}/events/{ev_id}/tickets", headers=api.headers("promoter")
    ).json()
    assert res["total"] == len(res["items"])  # coherente
    assert all(i["customer_name"] != "Directa Uno" for i in res["items"])
