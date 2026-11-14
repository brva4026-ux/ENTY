"""La sesion web no expone el JWT a JavaScript y rechaza CSRF."""


def test_login_sets_httponly_cookie_and_authenticates_without_bearer(api):
    user = api.world["admin"]
    response = api.client.post('/auth/login', json={
        'email': user['email'], 'password': api.world['password'],
    })
    assert response.status_code == 200
    cookie = response.headers.get('set-cookie', '').lower()
    assert 'httponly' in cookie and 'samesite=lax' in cookie
    assert api.client.get('/auth/me').status_code == 200


def test_cookie_session_rejects_cross_origin_mutation(api):
    api.token('admin')
    response = api.client.patch('/auth/profile', json={'full_name': 'Intruso'},
                                headers={'Origin': 'https://attacker.invalid'})
    assert response.status_code == 403


def test_logout_clears_cookie(api):
    api.token('admin')
    assert api.client.get('/auth/me').status_code == 200
    assert api.client.post('/auth/logout', headers={'Origin':'http://testserver'}).status_code == 200
    assert api.client.get('/auth/me').status_code == 401


def test_bearer_api_clients_remain_supported(api):
    headers = api.headers('admin')
    api.client.cookies.clear()
    assert api.client.get('/auth/me', headers=headers).status_code == 200


def test_legal_gate_accepts_cookie_session_without_exposing_token(api):
    api.token('admin')
    pending = api.client.get('/legal/status').json()['pending']
    assert pending
    document = pending[0]
    response = api.client.post('/legal/acceptances',
        json={'slug': document['slug'], 'version': document['version']},
        headers={'Origin': 'http://testserver'})
    assert response.status_code == 201, response.text
