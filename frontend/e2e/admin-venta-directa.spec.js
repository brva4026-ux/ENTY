/**
 * E2E de la venta directa del admin (Playwright).
 *
 * Regresión real: el commit e838fad agregó <EmitTicketPanel> al backstage,
 * pero el merge ff7c471 ("Merge branch 'master'") resolvió a favor del padre
 * que NO lo tenía y lo borró en silencio. El test de backend
 * (tests/test_admin_emit.py) siguió verde porque prueba el ENDPOINT, no la
 * pantalla: el admin quedó otra vez sin taquilla y nada lo delataba.
 *
 * Este spec cierra ese hueco: exige que la pestaña "Entradas" del backstage
 * monte el formulario de emisión y que emitir de verdad devuelva una boleta
 * con QR y enlace de entrega.
 *
 * Corre contra backend REAL con seed demo (E2E_BASE_URL, default
 * http://127.0.0.1:8001). Sin seed, se salta solo.
 */
import { expect, test } from "@playwright/test";

const ADMIN = { email: "admin@bar.test", password: "demo1234" };

async function loginAdmin(page) {
  await page.locator("#login-email").fill(ADMIN.email);
  await page.locator("#login-password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/admin/, { timeout: 10_000 });

  // Gate legal: la cuenta demo arrastra documentos pendientes, así que el
  // panel no se ve hasta aceptarlos. Se aceptan si aparecen (en CI la tabla
  // puede venir vacía y el gate no se pinta).
  const gate = page.getByRole("heading", {
    name: "Hay cambios en los términos",
  });
  const visible = await gate
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (visible) {
    const cajas = page.locator('input[type="checkbox"]');
    for (let i = 0; i < (await cajas.count()); i++) await cajas.nth(i).check();
    await page.getByRole("button", { name: "Acepto y continúo" }).click();
  }
}

test("la pestaña Entradas emite una boleta de venta directa", async ({
  page,
}) => {
  const loginOk = await page
    .goto("/login")
    .then(() => true)
    .catch(() => false);
  test.skip(!loginOk, "App no disponible");

  await loginAdmin(page);
  const card = page.locator(".evx-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await expect(page).toHaveURL(/\/admin\?event=\d+/, { timeout: 10_000 });

  // --- La pantalla existe (lo que el merge borró) -----------------------
  await page.getByRole("tab", { name: "Entradas" }).click();
  await expect(
    page.getByRole("heading", { name: "Emitir boleta" }),
  ).toBeVisible({ timeout: 10_000 });

  // Sin tipos o evento cerrado el formulario no se pinta: el seed trae un
  // evento publicado con tipos, pero si cambia se salta en vez de fallar.
  const form = page.locator("#emit-name");
  const hasForm = await form.isVisible().catch(() => false);
  test.skip(!hasForm, "El evento demo no está a la venta o no tiene tipos");

  // --- Emitir de verdad -------------------------------------------------
  const name = `E2E Venta Directa ${Date.now()}`;
  await form.fill(name);
  await page.locator("#emit-phone").fill("573001112233");
  await page.getByRole("button", { name: "Emitir boleta" }).click();

  // La boleta generada trae su QR y el enlace de entrega al invitado.
  await expect(page.getByText("Boleta generada")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/Enlace de la boleta/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Copiar enlace/ }),
  ).toBeVisible();

  // Y el listado de boletas del evento refleja la emisión (recarga real).
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });
});
