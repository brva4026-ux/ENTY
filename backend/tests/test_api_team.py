"""Tests del módulo Equipo: métricas de productividad por persona.

Cubre:
- permisos (solo admin/super_admin; promotor/bouncer/outsider fuera),
- last_login_at actualizado por el login y expuesto en stats,
- agregados de ventas/cupo por promotor y escaneos por portero,
- ventana `days` acotando los agregados,
- retrocompatibilidad: GET /users sigue igual (sin last_login_at).
"""


# ---------------------------------------------------------------------------
# Permisos
# ---------------------------------------------------------------------------
def test_team_stats_admin_only(api):
    scen = api.scenario()

    for who in ("promoter", "bouncer", "outsider"):
        res = api.get(f"/venues/{scen['venue']}/users/stats", who)
        assert res.status_code == 403, f"{who} no debe ver stats del equipo"

    res = api.get(f"/venues/{scen['venue']}/users/stats", "admin")
    assert res.status_code == 200, res.text


def test_team_stats_days_window_validated(api):
    scen = api.scenario()

    assert api.get(f"/venues/{scen['venue']}/users/stats?days=0", "admin").status_code == 422
    assert api.get(f"/venues/{scen['venue']}/users/stats?days=366", "admin").status_code == 422
    assert api.get(f"/venues/{scen['venue']}/users/stats?days=30", "admin").status_code == 200


# ---------------------------------------------------------------------------
# last_login_at
# ---------------------------------------------------------------------------
def test_login_updates_last_login_and_stats_expose_it(api):
    scen = api.scenario()

    # El promotor es personal operativo: su login cuenta en active_in_window
    # (los admins quedan fuera por diseño: gestionan, no producen).
    stats = api.get(f"/venues/{scen['venue']}/users/stats", "admin").json()
    promoter = next(m for m in stats["members"] if m["email"] == api.world["promoter"]["email"])
    login_before = promoter["last_login_at"]

    # Login real del promotor (el mismo flujo que usa la UI).
    res = api.client.post(
        "/auth/login",
        json={"email": api.world["promoter"]["email"], "password": api.world["password"]},
    )
    assert res.status_code == 200, res.text

    stats = api.get(f"/venues/{scen['venue']}/users/stats", "admin").json()
    promoter = next(m for m in stats["members"] if m["email"] == api.world["promoter"]["email"])

    if login_before is not None:
        assert promoter["last_login_at"] >= login_before
    assert promoter["last_login_at"] is not None

    # El login del promotor cuenta como actividad dentro de la ventana.
    assert stats["active_in_window"] >= 1


def test_users_list_stays_backward_compatible(api):
    """El contrato de GET /users no cambia (la migración es transparente)."""
    scen = api.scenario()
    res = api.get(f"/venues/{scen['venue']}/users", "admin")
    assert res.status_code == 200
    row = res.json()[0]
    assert set(row.keys()) == {"id", "email", "full_name", "roles", "is_active"}


# ---------------------------------------------------------------------------
# Agregados de productividad
# ---------------------------------------------------------------------------
def test_promoter_quota_and_sales_aggregated(api):
    scen = api.scenario()

    # El escenario deja cupo (5) pero SIN boletas emitidas: emitimos 2.
    alloc_id = scen["allocation"]["id"]
    api.emit("promoter", scen["venue"], scen["event"],
             ticket_type_id=scen["type"], allocation_id=alloc_id,
             customer_name="Uno")
    api.emit("promoter", scen["venue"], scen["event"],
             ticket_type_id=scen["type"], allocation_id=alloc_id,
             customer_name="Dos")

    stats = api.get(f"/venues/{scen['venue']}/users/stats", "admin").json()
    promoter = next(
        m for m in stats["members"] if m["email"] == api.world["promoter"]["email"]
    )
    assert "promotor" in promoter["roles"]
    assert promoter["quota"]["capacity"] == 5
    assert promoter["quota"]["issued"] == 2
    assert promoter["quota"]["redeemed"] == 0
    # Cortesía => recaudo 0, pero el campo existe y es entero.
    assert promoter["quota"]["revenue_cents"] == 0
    assert stats["promoters_active"] >= 1

    # KPIs coherentes entre sí.
    assert stats["total_members"] == len(stats["members"])
    assert stats["active_members"] <= stats["total_members"]
    assert set(stats["by_role"].keys()) == {"promotor", "bouncer", "admin"}


def test_bouncer_door_stats_aggregated(api):
    """Escaneos reales quedan agregados por portero (granted + rejected)."""
    scen = api.scenario()  # evento ya publicado con tipo cortesía + cupo

    # 2 boletas del promotor; la primera se canjeará (granted).
    alloc_id = scen["allocation"]["id"]
    t1 = api.emit("promoter", scen["venue"], scen["event"],
                  ticket_type_id=scen["type"], allocation_id=alloc_id)
    api.emit("promoter", scen["venue"], scen["event"],
             ticket_type_id=scen["type"], allocation_id=alloc_id)

    # Abrir puertas y escanear: un éxito y un token falso (rechazado).
    api.post(f"/venues/{scen['venue']}/events/{scen['event']}/live", "admin")

    api.post(f"/venues/{scen['venue']}/events/{scen['event']}/redeem", "bouncer",
             {"raw_token": t1["raw_token"]})
    api.post(f"/venues/{scen['venue']}/events/{scen['event']}/redeem", "bouncer",
             {"raw_token": "token-falso-que-no-existe"})

    stats = api.get(f"/venues/{scen['venue']}/users/stats", "admin").json()
    bouncer = next(m for m in stats["members"] if m["email"] == api.world["bouncer"]["email"])
    assert bouncer["door"]["granted"] >= 1
    assert bouncer["door"]["rejected"] >= 1
    assert bouncer["door"]["total"] == bouncer["door"]["granted"] + bouncer["door"]["rejected"]
    assert stats["bouncers_active"] >= 1
