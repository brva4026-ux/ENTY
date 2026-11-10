/**
 * Regresión: "¿Olvidaste tu contraseña?" no promete un correo que no sale.
 *
 * El backend responde siempre el mismo texto (anti-enumeración), pero ese
 * texto depende de si el correo está configurado (`email_enabled`). Antes
 * prometía "te enviamos un enlace" aunque el mailer fuera no-op (el default en
 * producción hoy): el usuario esperaba un enlace que nunca llegaba. Este spec
 * fija que la pantalla muestra EXACTAMENTE lo que el backend decide, en vez de
 * un texto propio que prometa el enlace pase lo que pase.
 *
 * El POST se STUBBEA (no se toca la DB ni el mailer): lo que se prueba es el
 * cableado de la UI, no el envío (eso lo cubre backend/tests/test_password_reset.py).
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";

test.beforeEach(async ({ request }) => {
  try {
    const res = await request.get(`${BASE}/api/health`);
    test.skip(!res.ok(), `Backend no disponible en ${BASE}`);
  } catch {
    test.skip(true, `Backend no disponible en ${BASE}`);
  }
});

/** Stubea /auth/forgot-password con el `detail` que devolvería el backend. */
async function stubForgot(page, detail) {
  await page.route("**/api/auth/forgot-password", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ detail }),
    }),
  );
}

/** Rellena el correo y pulsa el enlace "¿Olvidaste tu contraseña?". */
async function requestReset(page) {
  await page.goto("/login");
  await page.getByPlaceholder(/usuario o tu@/i).fill("fan@example.test");
  await page.getByRole("button", { name: /Olvidaste tu contraseña/i }).click();
}

test("sin correo configurado, no promete un enlace y orienta al admin", async ({
  page,
}) => {
  const detail =
    "El envío de correos todavía no está activo. Pídele a un administrador " +
    "de tu negocio que restablezca tu contraseña desde el panel de equipo.";
  await stubForgot(page, detail);

  await requestReset(page);

  // Se muestra el texto del backend tal cual: honesto, sin prometer el enlace.
  await expect(page.getByText(/envío de correos todavía no está activo/i)).toBeVisible();
  await expect(page.getByText(/te enviamos un enlace/i)).toHaveCount(0);
});

test("con correo configurado, muestra que se envió el enlace", async ({ page }) => {
  const detail =
    "Si el correo está registrado, te enviamos un enlace para restablecer " +
    "la contraseña. Revisa también tu carpeta de spam.";
  await stubForgot(page, detail);

  await requestReset(page);

  await expect(page.getByText(/te enviamos un enlace/i)).toBeVisible();
});
