/**
 * Regresión: la caja del backstage se puede cerrar por RANGO de fechas.
 *
 * El cierre de noche traía "todo el evento"; el contador a veces quiere solo
 * un periodo. El spec abre el backstage de una noche del seed y fija que el
 * rango Desde/Hasta y el botón "Caja (CSV)" están, y que la descarga baja un
 * CSV de verdad (nombre + contenido) con el periodo escrito.
 *
 * Corre contra backend REAL con seed demo (E2E_BASE_URL). Sin app, se salta.
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";
const ADMIN = { email: "admin@bar.test", password: "demo1234" };

test.beforeEach(async ({ request }) => {
  try {
    const res = await request.get(`${BASE}/api/health`);
    test.skip(!res.ok(), `Backend no disponible en ${BASE}`);
  } catch {
    test.skip(true, `Backend no disponible en ${BASE}`);
  }
});

/** Primera noche del seed (el admin la ve en su lista de eventos). */
async function seedEventId(request) {
  const res = await request.post(`${BASE}/api/auth/login`, { data: ADMIN });
  const token = (await res.json()).access_token;
  const me = await (
    await request.get(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  const venue = Number(Object.keys(me.roles)[0]);
  const events = await (
    await request.get(`${BASE}/api/venues/${venue}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  return events[0].id;
}

test("el backstage cierra la caja por rango y baja el CSV", async ({
  page,
  request,
}) => {
  const eventId = await seedEventId(request);

  await page.goto("/login");
  await page.locator("#login-email").fill(ADMIN.email);
  await page.locator("#login-password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/admin/, { timeout: 15_000 });

  await page.goto(`/admin?event=${eventId}`);

  // La tarjeta de cierre con su rango de caja.
  await expect(page.getByText("Cierre de noche")).toBeVisible({ timeout: 15_000 });
  const desde = page.getByLabel("Caja desde");
  const hasta = page.getByLabel("Caja hasta");
  await expect(desde).toBeVisible();
  await expect(hasta).toBeVisible();

  // Un periodo concreto: el CSV debe reflejarlo. "Hasta" es inclusivo, asi
  // que el API recibe el dia siguiente (2999-12-31 -> 3000-01-01).
  await desde.fill("2020-01-01");
  await hasta.fill("2999-12-31");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Caja \(CSV\)/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^caja-evento-\d+\.csv$/);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf-8");
  expect(body).toContain("Cierre de caja");
  expect(body).toContain("Periodo");
  expect(body).toContain("01/01/2020");
  expect(body).toContain("01/01/3000"); // hasta inclusivo -> dia siguiente
});
