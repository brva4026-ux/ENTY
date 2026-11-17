/**
 * Guardarraíl del interruptor de tema (cabecera autenticada).
 *
 * Antes era un botón que CICLABA a ciegas: nadie veía cuál era el modo activo
 * ni a dónde iba. Ahora abre un menú con las tres opciones, marca la activa y
 * persiste la elección en localStorage (tf_theme). Este spec fija ese
 * contrato y el del cursor, que Tailwind v4 dejó de poner en los botones.
 *
 * Corre contra el backend REAL con seed demo (E2E_BASE_URL); si la app no
 * responde, se salta solo, igual que el resto de specs.
 */
import { expect, test } from "@playwright/test";

const DEMO_PASSWORD = "demo1234";

async function available(page, path) {
  return page
    .goto(path)
    .then((r) => !!r && r.status() < 500)
    .catch(() => false);
}

async function login(page, email) {
  await page.goto("/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 10_000 });
}

/** Entra al panel y sortea el gate de términos si aparece (base sin re-sembrar). */
async function enterAdmin(page) {
  await login(page, "admin@bar.test");
  await page.goto("/admin");
  const gate = page.getByRole("heading", { name: "Hay cambios en los términos" });
  await page.waitForTimeout(800);
  if (await gate.isVisible().catch(() => false)) {
    const cajas = page.locator('input[type="checkbox"]');
    for (let i = 0; i < (await cajas.count()); i++) await cajas.nth(i).check();
    await page.getByRole("button", { name: "Acepto y continúo" }).click();
    await expect(gate).toHaveCount(0, { timeout: 10_000 });
  }
}

test("el interruptor abre las tres opciones, marca la activa y persiste", async ({
  page,
}) => {
  const ok = await available(page, "/login");
  test.skip(!ok, "App no disponible");
  await enterAdmin(page);

  const trigger = page.getByRole("button", { name: /^Cambiar tema/ });
  const menu = page.getByRole("menu", { name: "Tema de la aplicación" });

  // El cursor debe leerse como pulsable (Tailwind v4 ya no lo pone solo).
  expect(await trigger.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");

  await trigger.click();
  await expect(menu).toBeVisible();

  // Las tres opciones, con su estado de selección.
  const items = page.getByRole("menuitemradio");
  await expect(items).toHaveCount(3);
  await expect(page.getByRole("menuitemradio", { name: /^Sistema/ })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: /^Claro/ })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: /^Oscuro/ })).toBeVisible();

  // Claro: aplica el atributo, guarda la preferencia y cierra el menú.
  await page.getByRole("menuitemradio", { name: /^Claro/ }).click();
  await expect(menu).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");
  expect(await page.evaluate(() => localStorage.getItem("tf_theme"))).toBe("light");

  // Persiste tras recargar y la opción activa pasa a ser Claro.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");
  await trigger.click();
  await expect(page.getByRole("menuitemradio", { name: /^Claro/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Oscuro: quita el atributo (el default es oscuro) y guarda la preferencia.
  await page.getByRole("menuitemradio", { name: /^Oscuro/ }).click();
  await expect(menu).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme || ""))
    .toBe("");
  expect(await page.evaluate(() => localStorage.getItem("tf_theme"))).toBe("dark");
});

test("el menú de tema cierra con Escape y con click fuera, y devuelve el foco", async ({
  page,
}) => {
  const ok = await available(page, "/login");
  test.skip(!ok, "App no disponible");
  await enterAdmin(page);

  const trigger = page.getByRole("button", { name: /^Cambiar tema/ });
  const menu = page.getByRole("menu", { name: "Tema de la aplicación" });

  await trigger.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(6, 400);
  await expect(menu).toBeHidden();
});
