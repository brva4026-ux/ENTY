import { expect, test } from '@playwright/test';

test('una caida temporal conserva la cookie y permite recuperar la sesion', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@bar.test', password: 'demo1234' },
  });
  expect(login.ok()).toBeTruthy();
  const session = (await page.context().cookies()).find(c => c.name === 'tf_session');
  expect(session?.httpOnly).toBe(true);
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Temporarily unavailable' }),
  }));
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'No pudimos verificar tu sesión' })).toBeVisible();
  expect((await page.context().cookies()).some(c => c.name === 'tf_session')).toBe(true);
  await page.unroute('**/api/auth/me');
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No pudimos verificar tu sesión' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cerrar sesión', exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('tf_token'))).toBeNull();
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.context().cookies()).some(c => c.name === 'tf_session')).toBe(false);
});

test('aceptar una invitacion abre el panel sin volver a pedir login', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@bar.test', password: 'demo1234' },
  });
  const admin = await login.json();
  const venue = Object.keys(admin.user.roles)[0];
  const email = `cookie-invite-${Date.now()}@example.test`;
  const response = await page.request.post(`/api/auth/venues/${venue}/invitations`, {
    headers: { Authorization: `Bearer ${admin.access_token}` },
    data: { full_name: 'Invitado E2E', email, role: 'promotor' },
  });
  expect(response.ok()).toBeTruthy();
  const invitation = await response.json();
  const url = new URL(invitation.invite_url, 'http://127.0.0.1:12000');
  await page.context().clearCookies();
  await page.goto(url.pathname + url.search);
  await page.getByLabel('Crea tu contraseña').fill('Invitado-Seguro-2026');
  await page.getByLabel('Confírmala').fill('Invitado-Seguro-2026');
  await page.getByRole('button', { name: 'Crear mi cuenta y entrar' }).click();
  await page.getByRole('link', { name: 'Ir a mi panel' }).click();
  await expect(page).toHaveURL(/\/promotor/);
  expect((await (await page.request.get('/api/auth/me')).json()).email).toBe(email);
  expect(await page.evaluate(() => localStorage.getItem('tf_token'))).toBeNull();
});
