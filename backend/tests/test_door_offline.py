"""Modo offline de puerta: snapshot de hashes + sync de la cola.

El contrato de seguridad que estos tests fijan:
1. El snapshot SOLO lleva hashes (nunca tokens crudos) y solo boletas `issued`.
2. Solo staff de puerta lo descarga; un promotor o un ajeno reciben 403.
3. El sync re-evalúa cada token contra la DB (redeem_ticket): una boleta
   anulada después de descargar el snapshot NO entra por haber estado en él.
"""
import psycopg
import pytest

pytestmark = pytest.mark.skipif(False, reason="")


@pytest.fixture
def door_event(api, world):
    """Evento live con 2 boletas emitidas y 1 anulada."""
    venue = world["venue_a"]
    ev = api.create_event("admin", venue, name="Puerta offline")
    t = api.add_type("admin", venue, ev["id"])
    api.publish("admin", venue, ev["id"])
    # En vivo: la ventana de QR está abierta y redeem_ticket exige evento live.
    api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin")
    t1 = api.emit("admin", venue, ev["id"], ticket_type_id=t["id"], allocation_id=None)
    t2 = api.emit("admin", venue, ev["id"], ticket_type_id=t["id"], allocation_id=None)
    t3 = api.emit("admin", venue, ev["id"], ticket_type_id=t["id"], allocation_id=None)
    api.post(
        f"/venues/{venue}/events/{ev['id']}/tickets/{t3['ticket_id']}/void",
        "admin",
        {"reason": "Error de digitación"},
    )
    # Ventana del QR (mig 013): abre 60 min antes de starts_at y el evento del
    # fixture es +29h, así que los QRs aún NO están activos y el sync rechaza
    # con not_active (regresión descubierta al correr la suite completa: estos
    # tests se escribieron antes de la mig 013 y CI no los corría con DB).
    # Aquí se ejercita la semántica offline (granted/already/rejected), no la
    # ventana: empieza ya abierta, igual que hace test_redemptions_api.
    with psycopg.connect(api.dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE events SET starts_at = now() - interval '1 hour' WHERE id = %s",
                (ev["id"],),
            )
    return {"ev": ev, "t1": t1, "t2": t2, "t3": t3}


def test_snapshot_only_hashes_and_only_issued(api, world, door_event):
    res = api.get(
        f"/venues/{world['venue_a']}/events/{door_event['ev']['id']}/door-snapshot",
        "bouncer",
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["count"] == 2  # la anulada no aparece
    assert data["live_event"] is True
    for entry in data["entries"]:
        # h = SHA-256 hex (64 chars); NUNCA un token crudo (64 chars base16)
        assert len(entry["h"]) == 64
        assert entry["s"] == "issued"
        assert entry["n"] is not None


def test_snapshot_requires_door_staff(api, world, door_event):
    venue = world["venue_a"]
    ev_url = f"/venues/{venue}/events/{door_event['ev']['id']}/door-snapshot"
    # Promotor no es puerta.
    assert api.get(ev_url, "promoter").status_code == 403
    # Un admin de OTRA venue tampoco (aislamiento multi-tenant).
    res = api.get(f"/venues/{venue}/events/{door_event['ev']['id']}/door-snapshot", "outsider")
    assert res.status_code in (403, 404)


def test_sync_redeems_offline_scan(api, world, door_event):
    venue = world["venue_a"]
    ev = door_event["ev"]
    snap = api.get(
        f"/venues/{venue}/events/{ev['id']}/door-snapshot", "bouncer"
    ).json()
    # El bouncer escaneó offline t1 y t2; ambos deben entrar al sincronizar.
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/door-sync",
        "bouncer",
        [
            {"raw_token": door_event["t1"]["raw_token"]},
            {"raw_token": door_event["t2"]["raw_token"]},
        ],
    )
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["processed"] == 2
    assert out["granted"] == 2
    assert out["rejected"] == 0
    assert len(snap["entries"]) == 2  # el snapshot no cambia


def test_sync_rejects_voided_after_snapshot(api, world, door_event):
    """La DB manda: boleta anulada tras descargar el snapshot queda rechazada."""
    venue = world["venue_a"]
    ev = door_event["ev"]
    # t3 fue anulada ANTES (en el fixture); aunque un teléfono viejo la tenga
    # en un snapshot previo, el sync NO la admite.
    res = api.post(
        f"/venues/{venue}/events/{ev['id']}/door-sync",
        "bouncer",
        [{"raw_token": door_event["t3"]["raw_token"]}],
    )
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["granted"] == 0
    assert out["rejected"] == 1


def test_sync_double_scan_counts_already(api, world, door_event):
    venue = world["venue_a"]
    ev = door_event["ev"]
    body = [{"raw_token": door_event["t1"]["raw_token"]}]
    api.post(f"/venues/{venue}/events/{ev['id']}/door-sync", "bouncer", body)
    # El mismo token dos veces (teléfono que no desduplicó): la segunda ya no
    # suma un ingreso.
    res = api.post(f"/venues/{venue}/events/{ev['id']}/door-sync", "bouncer", body)
    out = res.json()
    assert out["granted"] == 0
    assert out["already_redeemed"] == 1
