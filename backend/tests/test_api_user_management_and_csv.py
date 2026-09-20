"""Tests de gestión de usuarios de la venue y exportación CSV.

Ciclo completo de un miembro del equipo: alta, edición parcial, reset de
contraseña, desactivación (revoca la sesión al instante), remoción de la
venue y recontratación. Regresión clave: recontratar a alguien que fue
removido debe reactivar su cuenta (si no, aparece en el equipo pero no
puede iniciar sesión).

Los CSV (invitados y recaudo) deben reflejar exactamente lo que muestra
el reporte del evento y ser legibles por Excel (BOM UTF-8).
"""
import csv
import io

PASSWORD = "test-password-123"


# ---------------------------------------------------------------------------
# Gestión de usuarios
# ---------------------------------------------------------------------------
def test_create_user_new_email(api):
    res = api.post(
        f"/venues/{api.world['venue_a']}/users",
        "admin",
        {
            "email": "nuevo-equipo@example.test",
            "full_name": "Nuevo Miembro",
            "password": PASSWORD,
            "role": "bouncer",
        },
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["email"] == "nuevo-equipo@example.test"
    assert body["roles"] == ["bouncer"]
    assert body["is_active"] is True


def test_rehire_after_removal_reactivates_account(api):
    """Removido de su única venue -> desactivado. Al recontratarlo, vuelve a
    poder iniciar sesión (regresión: quedaba activo en la lista pero 401)."""
    venue = api.world["venue_a"]
    payload = {
        "email": "recontratado@example.test",
        "full_name": "Re Contratado",
        "password": PASSWORD,
        "role": "bouncer",
    }
    created = api.post(f"/venues/{venue}/users", "admin", payload).json()

    # Remover de la venue: era su única venue, queda desactivado.
    assert api.delete(f"/venues/{venue}/users/{created['id']}", "admin").status_code == 200
    assert api.client.post("/auth/login", json={"email": payload["email"], "password": PASSWORD}).status_code == 401

    # Recontratar con el mismo email: reasigna el rol Y reactiva la cuenta.
    res = api.post(f"/venues/{venue}/users", "admin", payload)
    assert res.status_code == 201, res.text
    assert res.json()["is_active"] is True

    login = api.client.post("/auth/login", json={"email": payload["email"], "password": PASSWORD})
    assert login.status_code == 200, "recontratado debe poder iniciar sesión"


def test_patch_changes_role_and_name(api):
    venue = api.world["venue_a"]
    user = api.post(
        f"/venues/{venue}/users",
        "admin",
        {
            "email": "cambia-rol@example.test",
            "full_name": "Original",
            "password": PASSWORD,
            "role": "bouncer",
        },
    ).json()

    res = api.patch(
        f"/venues/{venue}/users/{user['id']}",
        "admin",
        {"role": "promotor", "full_name": "Renombrado"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["roles"] == ["promotor"], "el rol anterior debe reemplazarse"
    assert body["full_name"] == "Renombrado"


def test_reset_password_invalidates_old_credentials(api):
    venue = api.world["venue_a"]
    user = api.post(
        f"/venues/{venue}/users",
        "admin",
        {
            "email": "reset@example.test",
            "full_name": "Reset Target",
            "password": PASSWORD,
            "role": "promotor",
        },
    ).json()
    assert api.client.post("/auth/login", json={"email": user["email"], "password": PASSWORD}).status_code == 200

    res = api.post(
        f"/venues/{venue}/users/{user['id']}/reset-password",
        "admin",
        {"new_password": "Otra-Clave-456"},
    )
    assert res.status_code == 200, res.text

    assert api.client.post("/auth/login", json={"email": user["email"], "password": PASSWORD}).status_code == 401
    assert api.client.post("/auth/login", json={"email": user["email"], "password": "Otra-Clave-456"}).status_code == 200


def test_deactivate_revokes_active_session(api):
    """Desactivar debe cortar la sesión en curso, no solo el próximo login."""
    venue = api.world["venue_a"]
    user = api.post(
        f"/venues/{venue}/users",
        "admin",
        {
            "email": "desactivado@example.test",
            "full_name": "Desactivo",
            "password": PASSWORD,
            "role": "promotor",
        },
    ).json()
    res = api.client.get("/auth/me", headers=api.headers("promoter"))
    assert res.status_code == 200  # sanity del fixture

    token = api.client.post(
        "/auth/login", json={"email": user["email"], "password": PASSWORD}
    ).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert api.client.get("/auth/me", headers=headers).status_code == 200

    assert api.patch(f"/venues/{venue}/users/{user['id']}", "admin", {"is_active": False}).status_code == 200
    assert api.client.get("/auth/me", headers=headers).status_code == 401


def test_admin_cannot_disable_or_remove_self(api):
    venue = api.world["venue_a"]
    me = api.world["admin"]["id"]
    res = api.patch(f"/venues/{venue}/users/{me}", "admin", {"is_active": False})
    assert res.status_code == 400, res.text
    res = api.delete(f"/venues/{venue}/users/{me}", "admin")
    assert res.status_code == 400, res.text


def test_promoter_cannot_manage_users_or_download_csv(api):
    venue = api.world["venue_a"]
    event = api.create_event("admin", venue)
    assert api.get(f"/venues/{venue}/users", "promoter").status_code == 403
    assert api.get(f"/venues/{venue}/events/{event['id']}/guests.csv", "promoter").status_code == 403
    assert api.get(f"/venues/{venue}/events/{event['id']}/revenue.csv", "promoter").status_code == 403
    assert api.delete(f"/venues/{venue}/users/{api.world['bouncer']['id']}", "promoter").status_code == 403


# ---------------------------------------------------------------------------
# Exportación CSV
# ---------------------------------------------------------------------------
def _emit_paid_ticket(api, scenario: dict) -> None:
    """Boleta paga ($100.00): las pagas no usan cupo de promotor (regla de DB).

    Primero se emite una cortesía (para que el promotor tenga actividad en el
    evento) y luego la paga directa del admin, sin allocation.
    """
    venue, event = scenario["venue"], scenario["event"]
    paid = api.add_type(
        "admin", venue, event,
        name="General", price_cents=10000, quantity=50, is_courtesy=False,
    )
    api.emit(
        "admin", venue, event,
        ticket_type_id=paid["id"], allocation_id=None,
    )


def test_guests_csv_lists_all_tickets_with_bom(api):
    scenario = api.scenario()
    _emit_paid_ticket(api, scenario)
    venue, event = scenario["venue"], scenario["event"]

    res = api.get(f"/venues/{venue}/events/{event}/guests.csv", "admin")
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/csv")
    raw = res.content.decode("utf-8")
    assert raw.startswith("\ufeff"), "Excel requiere BOM UTF-8"

    rows = list(csv.DictReader(io.StringIO(raw.lstrip("\ufeff"))))
    # El total del listado paginado (Fase 2) trae {total, items[]}.
    listing = api.get(f"/venues/{venue}/events/{event}/tickets", "admin").json()
    expected = listing["total"]
    assert len(rows) == expected > 0
    assert {"Boleta", "Nombre", "Estado", "Ingresó"} <= set(rows[0].keys())


def test_revenue_csv_matches_report(api):
    scenario = api.scenario()
    _emit_paid_ticket(api, scenario)
    venue, event = scenario["venue"], scenario["event"]

    res = api.get(f"/venues/{venue}/events/{event}/revenue.csv", "admin")
    assert res.status_code == 200, res.text
    rows = list(csv.DictReader(io.StringIO(res.content.decode("utf-8-sig"))))
    total = next(r for r in rows if r["Tipo de boleta"] == "TOTAL")
    assert total["Emitidas"] == "1"
    assert total["Anuladas"] == "0"
    assert total["Recaudo (cents)"] == "10000"

    report = api.get(f"/venues/{venue}/events/{event}/report", "admin").json()
    assert report["revenue_cents"] == int(total["Recaudo (cents)"]), \
        "el CSV y el reporte deben coincidir siempre"
