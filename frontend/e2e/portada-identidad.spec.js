/**
 * E2E de la IDENTIDAD de la portada del admin (Playwright).
 *
 * Regresiones cubiertas:
 *  - El tile de iniciales mostraba UNA sola letra ("Bar Esquina" -> "B") aunque
 *    el CSS ya reservaba `letter-spacing` para dos: parecía un avatar genérico.
 *  - `venues.primary_color` existía en la DB y viajaba en /auth/me, pero el
 *    frontend no lo leía en ningún sitio: la personalización de marca era
 *    invisible. Ahora tiñe banner, tile y viga del KPI.
 *  - La portada no daba señal del estado operativo: con la puerta abierta, el
 *    dueño tenía que entrar al evento para saberlo. Ahora hay chip "En vivo".
 *
 * Corre contra backend REAL con seed demo (E2E_BASE_URL, default
 * http://127.0.0.1:8001). Sin seed se salta solo, como el spec de portada.
 */
import { expect, test } from "@playwright/test";

const ADMIN = { email: "admin@bar.test", password: "demo1234" };
const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("tf_cookie_notice", "1.1");
    } catch {
      /* sin storage el aviso vuelve, pero no es lo que se prueba aquí */
    }
  });
});

async function loginAdmin(page) {
  await page.goto("/login");
  await page.locator("#login-email").fill(ADMIN.email);
  await page.locator("#login-password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/admin/, { timeout: 15_000 });
}

test("el tile de identidad muestra DOS iniciales, no una", async ({ page }) => {
  const ok = await page
    .goto("/login")
    .then(() => true)
    .catch(() => false);
  test.skip(!ok, "App no disponible");

  await loginAdmin(page);
  const tile = page.locator(".vh-logo-fallback");
  await expect(tile).toBeVisible();
  // Dos letras: la regresión era exactamente "B" en vez de "BE".
  await expect(tile).toHaveText(/^[A-ZÁÉÍÓÚÑ]{2}$/);
});

test("la portada tiene banner de marca y el lockup lleva al negocio", async ({
  page,
}) => {
  const ok = await page
    .goto("/login")
    .then(() => true)
    .catch(() => false);
  test.skip(!ok, "App no disponible");

  await loginAdmin(page);

  // Banner decorativo: existe y no aporta texto al árbol de accesibilidad.
  const banner = page.locator(".vh-banner");
  await expect(banner).toHaveCount(1);
  await expect(banner).toHaveAttribute("aria-hidden", "true");

  // El lockup es el camino a editar el negocio (nombre, logo, color).
  await expect(page.locator(".vh-identidad")).toHaveAttribute(
    "href",
    "/perfil?tab=negocio"
  );
});

test("el color de marca del negocio se puede elegir y tiñe la portada", async ({
  page,
}) => {
  const ok = await page
    .goto("/login")
    .then(() => true)
    .catch(() => false);
  test.skip(!ok, "App no disponible");

  await loginAdmin(page);
  const header = page.locator(".venue-header");
  const antes = await header.evaluate((el) =>
    getComputedStyle(el).getPropertyValue("--vh-brand").trim()
  );

  // Se elige un color en el perfil y se guarda.
  await page.goto("/perfil?tab=negocio");
  const color = page.locator("#venue-color");
  await expect(color).toBeVisible();
  await color.fill("#0f9d58");
  await page.getByRole("button", { name: "Guardar organización" }).click();
  await expect(page.getByText("Organización guardada y confirmada por el servidor")).toBeVisible();

  // De vuelta en el panel, la portada lleva SU color (no el violeta de Enty).
  await page.goto("/admin");
  await expect(page.locator(".venue-header")).toBeVisible();
  await expect
    .poll(
      () =>
        page
          .locator(".venue-header")
          .evaluate((el) =>
            getComputedStyle(el).getPropertyValue("--vh-brand").trim()
          ),
      { timeout: 10_000 }
    )
    .toBe("#0f9d58");

  // Y el tile de iniciales deja de usar el navy por defecto.
  await expect(page.locator(".venue-header")).toHaveAttribute("data-brand", "1");

  // Restaurar el estado del seed: otros specs asumen el violeta de Enty.
  await page.goto("/perfil?tab=negocio");
  await page.getByRole("button", { name: "Quitar" }).click();
  await page.getByRole("button", { name: "Guardar organización" }).click();
  await expect(page.getByText("Organización guardada y confirmada por el servidor")).toBeVisible();
  expect(antes).toBeDefined();
});

test("con la puerta abierta, la tarjeta del evento avisa 'En puerta'", async ({
  page,
  request,
}) => {
  const ok = await page
    .goto("/login")
    .then(() => true)
    .catch(() => false);
  test.skip(!ok, "App no disponible");

  // Tema oscuro explícito: es el default de la marca y hace determinista el
  // verde del chip (en claro el mismo estado usa el tono oscurecido).
  await page.addInitScript(() => {
    try {
      localStorage.setItem("tf_theme", "dark");
    } catch {
      /* sin storage el tema cae al del sistema, pero no es lo que se prueba */
    }
  });

  // Noche publicada y abierta por API: el chip se prueba sobre estado real,
  // no sobre un mock. Se crea aquí para no depender de que el seed esté live.
  const login = await request.post(`${BASE}/api/auth/login`, {
    data: ADMIN,
  });
  test.skip(!login.ok(), "Sin seed demo");
  const token = (await login.json()).access_token;
  const auth = { Authorization: `Bearer ${token}` };
  const me = await (await request.get(`${BASE}/api/auth/me`, { headers: auth })).json();
  const venue = Number(Object.keys(me.roles)[0]);

  // El chip muestra UNA noche (la primera en vivo). Para que la aserción sea
  // determinista, se cierran las que ya estuvieran abiertas antes de crear la
  // propia.
  const previos = await (
    await request.get(`${BASE}/api/venues/${venue}/events`, { headers: auth })
  ).json();
  for (const e of Array.isArray(previos) ? previos : []) {
    if (e.status === "live") {
      await request.post(`${BASE}/api/venues/${venue}/events/${e.id}/end`, {
        headers: auth,
      });
    }
  }

  const starts = new Date(Date.now() + 5 * 60_000).toISOString();
  const ev = await (
    await request.post(`${BASE}/api/venues/${venue}/events`, {
      headers: auth,
      data: {
        name: `E2E-VIVO-${Date.now()}`,
        starts_at: starts,
        capacity: 50,
        qr_unlock_minutes: 60,
      },
    })
  ).json();
  await request.post(`${BASE}/api/venues/${venue}/events/${ev.id}/publish`, {
    headers: auth,
  });
  await request.post(`${BASE}/api/venues/${venue}/events/${ev.id}/live`, {
    headers: auth,
  });

  await loginAdmin(page);
  // La tarjeta del listado es la que avisa "En puerta" y marca is-live.
  const card = page.locator(".evx-card").filter({ hasText: ev.name });
  await expect(card).toBeVisible();
  await expect(card.locator(".admin-state")).toHaveText("En puerta");
  await expect(card).toHaveClass(/is-live/);

  // Cerrar la puerta cambia el estado de la tarjeta (no es un adorno permanente).
  await request.post(`${BASE}/api/venues/${venue}/events/${ev.id}/end`, {
    headers: auth,
  });
  await page.reload();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: /Ver historial/ }).click();
  await expect(card.locator(".admin-state")).toHaveText("Finalizado");

  // Limpieza: el evento de prueba no debe quedar en el seed de otros specs.
  const cleanup = await request.fetch(
    `${BASE}/api/venues/${venue}/events/${ev.id}`,
    { method: "DELETE", headers: auth, data: { confirm: ev.name } },
  );
  expect(cleanup.ok()).toBeTruthy();
});
