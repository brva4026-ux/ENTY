"""Política de contraseñas: register/change/reset la exigen de verdad.

Antes el backend solo pedía longitud: "aaaaaaaa" era una contraseña válida
por la API aunque la UI prometiera mayúscula + minúscula + número. Ahora la
política vive en app.core.password_policy y la aplican los tres endpoints
que aceptan contraseñas nuevas.
"""
import pytest


def _register(api, password, email="pol@example.test"):
    return api.client.post(
        "/auth/register",
        json={
            "venue_name": "Teatro Politica",
            "full_name": "Dueno Politica",
            "email": email,
            "password": password,
        },
    )


@pytest.mark.parametrize(
    # 'num'/'min'/'may' nunca fueron claves de la policy: son 'digit'/'lower'
    # /'upper', y el mensaje es en español ("número", etc.). El assert busca
    # en el texto REAL del error (str(dict) en minúsculas).
    "password, requirement",
    [
        ("aaaa1234", "mayúscula"),    # sin mayuscula
        ("AAAA1234", "minúscula"),    # sin minuscula
        ("Abcdefgh", "número"),       # sin numero
        ("Ab1x", "mínimo"),           # demasiado corta (422 por longitud)
    ],
)
def test_register_rejects_weak_passwords(api, password, requirement):
    res = _register(api, password)
    assert res.status_code == 422
    detail = str(res.json().get("detail", ""))
    if requirement:
        assert requirement in detail.lower()


def test_register_accepts_strong_password(api):
    res = _register(api, "ClaveSegura1", email="pol-ok@example.test")
    assert res.status_code == 201, res.text


def test_change_password_rejects_weak_new(api):
    reg = _register(api, "ClaveVieja1", email="pol-change@example.test")
    headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}
    # Sin numero: la politica la rechaza aunque tenga mayuscula y longitud.
    res2 = api.client.post(
        "/auth/change-password",
        headers=headers,
        json={"current_password": "ClaveVieja1", "new_password": "SinNumerosAqui"},
    )
    assert res2.status_code == 422
    assert "n" in str(res2.json().get("detail", "")).lower()


def test_admin_reset_rejects_weak_password(api):
    venue = api.world["venue_a"]
    created = api.post(
        f"/venues/{venue}/users",
        "admin",
        {
            "email": "reset-pol@example.test",
            "full_name": "Reset Politica",
            "password": "ClaveEquipo1",
            "role": "promotor",
        },
    ).json()
    res = api.post(
        f"/venues/{venue}/users/{created['id']}/reset-password",
        "admin",
        {"new_password": "minusc1234"},
    )
    assert res.status_code == 422
    assert "may" in str(res.json().get("detail", "")).lower()
