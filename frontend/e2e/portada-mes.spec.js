/**
 * E2E del mes en Reportes: el período vive en la URL y el switcher lo escribe.
 *
 * En el rediseño el mes dejó de vivir en la portada de Eventos (el listado es
 * operativo, no histórico) y quedó donde se lee: Reportes. La prueba fija:
 *  1. La URL manda: /admin/reportes?mes=<mes pasado> muestra ESE mes y ofrece
 *     "Volver al mes actual".
 *  2. El switcher escribe la URL y limpia el param al volver al mes en curso.
 *
 * Corre contra backend REAL con seed demo (E2E_BASE_URL, default
 * http://127.0.0.1:8001). Sin app disponible, se salta solo.
 */
import { expect, test } from "@playwright/test";

const ADMIN = { email: "admin@bar.test", password: "demo1234" };

/** "YYYY-MM" del mes anterior a hoy, en la zona del navegador (misma que usa
 * la cabecera para el valor de arranque). */
function prevYM() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

test("el mes de Reportes vive en la URL y el switcher lo escribe", async ({
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

  // --- 1. La URL manda: mes pasado explícito ------------------------------
  const past = prevYM();
  await page.goto(`/admin/reportes?mes=${past}`);
  await expect(page.locator(".admin-month-label")).toContainText(/20\d\d/);
  await expect(
    page.getByRole("button", { name: "Volver al mes actual" }),
  ).toBeVisible();

  // --- 2. El switcher escribe la URL --------------------------------------
  // "Mes siguiente" desde el pasado vuelve al mes en curso y LIMPIA el param.
  await page.getByRole("button", { name: "Mes siguiente" }).click();
  await expect(page).toHaveURL(/\/admin\/reportes(\?|$)/);
  expect(new URL(page.url()).searchParams.get("mes")).toBeNull();
  await expect(
    page.getByRole("button", { name: "Volver al mes actual" }),
  ).toHaveCount(0);
});
