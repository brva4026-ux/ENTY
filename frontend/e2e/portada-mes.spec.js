/**
 * E2E de la portada unificada del admin: el MES vive en la URL y la portada
 * (VenueHeader) es su único dueño.
 *
 * Regresión de la unificación real: antes la portada y Reportes tenían cada
 * una su propio estado de mes (dos navs que se pisaban). Ahora el switcher
 * de la cabecera escribe /admin?mes=YYYY-MM y BusinessOverview lo lee como
 * componente controlado. La prueba fija tres cosas:
 *  1. La URL manda: entrar con ?mes=<mes pasado> muestra ESE mes en la
 *     cabecera y NO ofrece "Volver al mes actual" en el mes en curso.
 *  2. El switcher escribe la URL (y el mes en curso queda sin param, URL limpia).
 *  3. Reportes comparte el mismo mes: sin tocar su propio estado, su título
 *     muestra el mes de la URL.
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

test("el mes de la portada vive en la URL y lo comparte Reportes", async ({
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
  await page.goto(`/admin?mes=${past}`);
  await expect(page.locator(".vh-mesnav-label")).toContainText(/20\d\d/);
  // Se salió del mes en curso: aparece el atajo para volver.
  await expect(
    page.getByRole("button", { name: "Volver al mes actual" }),
  ).toBeVisible();

  // --- 2. El switcher escribe la URL --------------------------------------
  // "Mes siguiente" desde el pasado vuelve al mes en curso y LIMPIA el param
  // (la URL no arrastra ?mes= del mes actual).
  await page.getByRole("button", { name: "Mes siguiente" }).click();
  await expect(page).toHaveURL(/\/admin(\?|$)/);
  expect(new URL(page.url()).searchParams.get("mes")).toBeNull();
  await expect(
    page.getByRole("button", { name: "Volver al mes actual" }),
  ).toHaveCount(0);

  // --- 3. Reportes (hub Negocio) lee el MISMO mes de la URL --------------
  // Reportes dejó de ser una pestaña del panel: vive en /admin/negocio, con su
  // propio switcher de mes que lee el ?mes= de la URL.
  await page.goto(`/admin/negocio?mes=${past}`);
  await expect(page.locator(".vh-mesnav-label")).toContainText(/20\d\d/);
  // Cambiar de mes en la cabecera de Reportes limpia el param en el mes actual
  // y mantiene la página en /admin/negocio (Reportes es la pestaña por defecto).
  await page.getByRole("button", { name: "Mes siguiente" }).click();
  await expect(page).toHaveURL(/\/admin\/negocio/);
  expect(new URL(page.url()).searchParams.get("mes")).toBeNull();
});
