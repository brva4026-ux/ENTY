/**
 * E2E de la demo en video de la portada pública.
 *
 * Cubre el recorrido que el visitante hace sin cuenta: «Explorar Enty» baja a
 * la demostración, el video arranca a pedido, el CTA de registro sigue a la
 * vista y la sección no se rompe si el archivo no carga.
 */
import { expect, test } from "@playwright/test";

async function openLanding(page, path = "/") {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("tf_cookie_notice", "1.1");
    } catch {
      // Sin persistencia el aviso puede salir; no bloquea la demo.
    }
  });
  // La demo es de la portada pública: la cartelera y la sesión no cambian lo
  // que se prueba y, sin mock, un backend lento retrasa el primer render.
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"No autenticado"}' }),
  );
  await page.route("**/api/public/events**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"events":[],"count":0,"has_more":false}',
    }),
  );
  const ok = await page
    .goto(path)
    .then((r) => !!r && r.status() < 500)
    .catch(() => false);
  test.skip(!ok, "App no disponible");
}

test("Explorar Enty lleva a la demo sin quedar bajo el encabezado", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLanding(page);
  await page.getByRole("link", { name: "Explorar Enty" }).click();

  await expect(page).toHaveURL(/#funciones$/);
  const heading = page.getByRole("heading", { name: "Mira cómo funciona Enty" });
  await expect(heading).toBeVisible();
  await expect
    .poll(async () => heading.evaluate((el) => Math.round(el.getBoundingClientRect().top)))
    .toBeGreaterThanOrEqual(56);
  await expect(
    page.getByRole("button", { name: /Reproducir la demostración de 25 segundos/ }),
  ).toBeVisible();
});

test("abrir /#funciones en frío alinea la demo", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLanding(page, "/#funciones");
  const heading = page.getByRole("heading", { name: "Mira cómo funciona Enty" });
  await expect(heading).toBeVisible();
  await expect
    .poll(async () => heading.evaluate((el) => Math.round(el.getBoundingClientRect().top)), {
      timeout: 10_000,
    })
    .toBeLessThan(200);
  const top = await heading.evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(56);
});

test("el video arranca y se pausa, y el foco pasa al reproductor", async ({
  page,
}) => {
  await openLanding(page, "/#funciones");
  await page.getByRole("button", { name: /Reproducir la demostración/ }).click();

  const video = page.locator("video");
  await expect(video).toHaveAttribute("controls", "");
  await expect(video).toHaveAttribute("preload", "none");
  await expect(video).toHaveAttribute("playsinline", "");
  await expect
    .poll(() => video.evaluate((v) => v.currentTime), { timeout: 15_000 })
    .toBeGreaterThan(0.2);
  const size = await video.evaluate((v) => ({ width: v.videoWidth, height: v.videoHeight }));
  expect(size.height).toBeGreaterThan(size.width);
  await expect.poll(() => video.evaluate((v) => document.activeElement === v)).toBe(true);

  await video.evaluate((v) => v.pause());
  await expect.poll(() => video.evaluate((v) => v.paused)).toBe(true);
  await expect(page.getByText(/Recorrido de 25 segundos, sin audio/)).toBeVisible();
});

test("a 320 px no hay scroll horizontal y siguen el CTA y las seis funciones", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openLanding(page, "/#funciones");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(
    page.getByRole("button", { name: /Reproducir la demostración/ }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Crear mi primer evento" })).toHaveAttribute(
    "href",
    "/register",
  );
  await expect(page.locator(".lp-card")).toHaveCount(6);
  await expect(page.getByRole("link", { name: "Crear cuenta" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Iniciar sesión" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Eventos abiertos" })).toBeVisible();
});

test("Crear mi primer evento abre el registro", async ({ page }) => {
  await openLanding(page, "/#funciones");
  await page.getByRole("link", { name: "Crear mi primer evento" }).click();
  await expect(page).toHaveURL(/\/register$/);
});

test("si el video falla, quedan la descripción, el CTA y las funciones", async ({
  page,
}) => {
  await page.route("**/media/enty-demo.*", (route) => route.abort());
  await openLanding(page, "/#funciones");
  await page.getByRole("button", { name: /Reproducir la demostración/ }).click();

  await expect(page.getByText("El video no está disponible ahora.")).toBeVisible();
  await expect(page.getByText(/Recorrido de 25 segundos, sin audio/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Crear mi primer evento" })).toBeVisible();
  await expect(page.locator(".lp-card")).toHaveCount(6);
});
