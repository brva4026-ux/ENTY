/**
 * E2E de "Eventos más ricos" (mig 043): lineup, cupones y su aplicación en el
 * checkout público.
 *
 * Fija el cableado de la UI nueva contra el backend REAL con el seed demo:
 *  - el admin agrega y borra un acto del lineup (pestaña Lineup);
 *  - el admin crea y borra un cupón (pestaña Cupones);
 *  - el fan aplica un cupón en el checkout y ve el precio con descuento.
 *
 * El POST a Wompi se STUBBEA (no hay claves en el entorno de test): lo que se
 * prueba es el cableado, no la pasarela (eso lo cubre
 * backend/tests/test_eventos_ricos.py contra la DB).
 *
 * Corre contra el dev server (proxy /api). Sin app, se salta solo.
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";
const ADMIN = { email: "admin@bar.test", password: "demo1234" };

test.beforeEach(async ({ request }) => {
  try {
    const res = await request.get(`${BASE}/api/health`);
    test.skip(!res.ok(), `App no disponible en ${BASE}`);
  } catch {
    test.skip(true, `App no disponible en ${BASE}`);
  }
});

/** Id del evento del seed (estable y controlado por el test). */
async function seedEventId(request) {
  const events = await (
    await request.get(`${BASE}/api/public/events?limit=100`)
  ).json();
  const list = events.events || events;
  const ev = list.find((e) => e.name === "Noche Electrónica") || list[0];
  test.skip(!ev, "El seed demo no tiene eventos");
  return ev.id;
}

async function loginAdmin(page) {
  await page.goto("/login");
  await page.locator("#login-email").fill(ADMIN.email);
  await page.locator("#login-password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/admin/, { timeout: 15_000 });
}

test("el admin arma el lineup y lo ve en la ficha pública", async ({
  page,
  request,
}) => {
  const eventId = await seedEventId(request);
  const act = "E2E-DJ-" + Date.now();

  await loginAdmin(page);
  await page.goto(`/admin?event=${eventId}&tab=lineup`);

  await expect(page.getByRole("heading", { name: "Lineup" })).toBeVisible({
    timeout: 10_000,
  });

  // Agrega un acto: aparece en la lista en el acto.
  await page.getByLabel("Nombre del nuevo acto").fill(act);
  await page.getByRole("button", { name: "Agregar al lineup" }).click();
  await expect(page.getByText(act)).toBeVisible({ timeout: 10_000 });

  // La ficha pública lo muestra en la pestaña Lineup.
  await page.goto(`/evento/${eventId}`);
  await page.getByRole("tab", { name: "Lineup" }).click();
  await expect(page.getByText(act)).toBeVisible({ timeout: 10_000 });

  // Limpieza: se quita el acto para no ensuciar el seed.
  await page.goto(`/admin?event=${eventId}&tab=lineup`);
  const row = page.locator("li", { hasText: act });
  await row.getByRole("button", { name: "Quitar" }).click();
  await page.locator("#dialog-primary-btn").click();
  await expect(page.getByText(act)).toHaveCount(0, { timeout: 10_000 });
});

test("el admin crea y borra un cupón", async ({ page, request }) => {
  const eventId = await seedEventId(request);
  const code = "E2E" + Date.now().toString().slice(-6);

  await loginAdmin(page);
  await page.goto(`/admin?event=${eventId}&tab=cupones`);

  await expect(page.getByRole("heading", { name: "Cupones" })).toBeVisible({
    timeout: 10_000,
  });

  await page.getByLabel("Código del cupón").fill(code);
  await page.getByRole("button", { name: "Crear cupón" }).click();
  const codeCell = page.getByText(code, { exact: true });
  await expect(codeCell).toBeVisible({ timeout: 10_000 });

  // Borrar (nadie lo usó): desaparece.
  const row = page.locator("li", { hasText: code });
  await row.getByRole("button", { name: "Eliminar" }).click();
  await page.locator("#dialog-primary-btn").click();
  await expect(codeCell).toHaveCount(0, { timeout: 10_000 });
});

test("el fan aplica un cupón y ve el precio con descuento", async ({
  page,
  request,
}) => {
  const eventId = await seedEventId(request);

  // El seed local no tiene Wompi configurado: se fuerza `payments_enabled`
  // para que aparezca el CTA de compra (mismo truco que fan-checkout.spec).
  await page.route("**/api/public/events/*", async (route) => {
    const url = route.request().url();
    if (!/\/events\/\d+(\?|$)/.test(url)) return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    body.payments_enabled = true;
    await route.fulfill({ response: res, json: body });
  });
  // Cotización del cupón: válida con 20% de descuento.
  await page.route("**/api/public/events/*/coupon*", async (route) => {
    const price = 30000;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        code: "TEMPRANO20",
        discount_in_cents: 6000,
        original_in_cents: price,
        final_in_cents: price - 6000,
        valid: true,
      }),
    });
  });
  await page.route("**/api/public/events/*/checkout", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        reference: "TF-1-stub",
        payment_url: "https://checkout.wompi.co/l/stub",
        amount_in_cents: 2400000,
        event_id: eventId,
        event_name: "Stub",
        status: "pending",
      }),
    }),
  );

  await page.goto(`/evento/${eventId}`);
  await page.getByRole("button", { name: /Comprar boleto/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Antes del cupón: precio de lista (el seed vende General a $300).
  await expect(page.getByRole("button", { name: /Pagar/ })).toContainText(
    "300",
  );

  await page.getByLabel("Código de descuento").fill("TEMPRANO20");
  await page.getByRole("button", { name: "Aplicar" }).click();

  // Con el cupón: el aviso y el botón reflejan el precio neto (−$60).
  await expect(page.getByText(/Cupón TEMPRANO20 aplicado/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: /Pagar/ })).toContainText(
    "240",
  );
});
