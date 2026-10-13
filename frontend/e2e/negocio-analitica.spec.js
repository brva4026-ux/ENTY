/**
 * E2E de la analítica de negocio (Reportes del admin).
 *
 * Regresión de las dos métricas nuevas del mes: el RITMO de venta (con
 * cuánta anticipación se compra) y la RETENCIÓN (compradores que ya habían
 * comprado antes). Ambas viven en /admin?tab=negocio y se alimentan de
 * GET /venues/{id}/overview. La prueba fija que las dos tarjetas montan con
 * datos reales del seed (no en estado vacío): si el endpoint deja de
 * devolver sales_curve/retention_*, o el componente no las pinta, cae.
 *
 * Corre contra backend REAL con seed demo (E2E_BASE_URL, default
 * http://127.0.0.1:8001). Sin app disponible, se salta solo.
 */
import { expect, test } from "@playwright/test";

const ADMIN = { email: "admin@bar.test", password: "demo1234" };

test("Reportes muestra el ritmo de venta y los clientes que vuelven", async ({
  page,
}) => {
  const loginOk = await page
    .goto("/login")
    .then(() => true)
    .catch(() => false);
  test.skip(!loginOk, `App no disponible`);

  await page.locator("#login-email").fill(ADMIN.email);
  await page.locator("#login-password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/admin/, { timeout: 10_000 });

  await page.goto("/admin?tab=negocio");

  // Ritmo de venta: los 5 tramos de anticipación, del más lejano al más
  // cercano. El seed vende dentro del mes, así que hay al menos una barra
  // con boletas (>0): no es el estado vacío.
  await expect(
    page.getByText("Ritmo de venta", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("30+ días antes")).toBeVisible();
  await expect(page.getByText("Últimos 2 días")).toBeVisible();
  await expect(page.getByText("Con cuánta anticipación se vendieron")).toBeVisible();

  // Retención: con compradores identificados por teléfono, la tarjeta sale
  // con la proporción (no el estado "sin compradores con teléfono").
  await expect(page.getByText("Clientes que vuelven")).toBeVisible();
  await expect(page.getByText("recurrentes")).toBeVisible();
  await expect(page.getByText("nuevos")).toBeVisible();
  await expect(
    page.getByText("Sin compradores con teléfono"),
  ).toHaveCount(0);
});
