/**
 * Registro flexible: la misma puerta sirve a quien organiza una noche y a
 * quien administra un negocio. El nombre del negocio es opcional y el usuario
 * se genera con lo que la persona sí dio.
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";

async function backendDisponible() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page }) => {
  test.skip(!(await backendDisponible()), `Backend no disponible en ${BASE}`);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("tf_cookie_notice", "1.1");
    } catch {
      /* sin storage el aviso vuelve, pero no es lo que se prueba aqui */
    }
  });
});

function sello() {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function llenarAlta(page, { email, nombre, negocio }) {
  await page.goto("/register");
  await page.locator('input[placeholder="Ana Gómez"]').fill(nombre);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[autocomplete="new-password"]').fill("Demo1234");
  if (negocio !== undefined) {
    await page.locator('input[placeholder="Bar La Esquina"]').fill(negocio);
  }
  await page.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await page.waitForURL(/\/admin/, { timeout: 20_000 });
}

test("sin negocio: la cuenta nace con el nombre de la persona", async ({
  page,
}) => {
  const id = sello();
  await page.goto("/register");
  await expect(
    page.getByText("Déjalo vacío si organizas por tu cuenta.")
  ).toBeVisible();

  await llenarAlta(page, {
    nombre: "Ana Personal",
    email: `e2e-personal-${id}@test.local`,
  });

  const tarjeta = page.locator(".account-ready");
  await expect(tarjeta).toBeVisible();
  await expect(tarjeta.locator(".account-ready-handle")).toContainText(
    "@ana.personal"
  );
  // El espacio interno existe para poder trabajar, pero no se presenta como
  // si la persona hubiera escrito un nombre de negocio.
  await expect(page.locator(".vh-nombre-titulo")).toHaveText("Mi organización");
});

test("con negocio: el usuario sale del negocio, no del correo", async ({
  page,
}) => {
  const id = sello();
  await llenarAlta(page, {
    nombre: "Beto Negocio",
    email: `e2e-negocio-${id}@test.local`,
    negocio: `Bar E2E ${id}`,
  });

  await expect(page.locator(".account-ready-handle")).toContainText(
    `@bar.e2e.${id}`
  );
});

test("cambiar usuario desde la bienvenida enfoca el campo correcto", async ({
  page,
}) => {
  const id = sello();
  await llenarAlta(page, {
    nombre: "Carla Ajuste",
    email: `e2e-ajuste-${id}@test.local`,
  });

  await page.getByRole("button", { name: "Cambiar usuario" }).click();
  await page.waitForURL(/\/perfil#username/, { timeout: 20_000 });
  await expect(page.locator("#username")).toBeFocused();
  await expect(page.locator(".account-ready")).toBeHidden();
});
