/**
 * E2E del lado fan: Inicio (vitrina) -> detalle de evento -> Mis boletos.
 *
 * Es el camino publico sin login que estrena la app del fan:
 *  1. /inicio lista el catalogo real (seed demo) con buscador y categorias,
 *     y cada fila enlaza a su detalle.
 *  2. /evento/:id muestra el detalle publico (fecha, ubicacion, precio, CTA
 *     y pestanas). Un id inexistente cae al estado "no disponible", no a un
 *     crash.
 *  3. El CTA de compra se resuelve por tipo de evento: con localidad de pago
 *     abre el checkout publico; sin ella (gratis) lleva a /boletas.
 *
 * Corre contra backend REAL con seed demo (E2E_BASE_URL, default
 * http://127.0.0.1:8001). Sin app disponible, se salta solo.
 */
import { expect, test } from "@playwright/test";

test("Inicio -> detalle -> Mis boletos", async ({ page }) => {
  const ok = await page
    .goto("/inicio")
    .then(() => true)
    .catch(() => false);
  test.skip(!ok, "App no disponible");

  // Inicio: header de marca, buscador y el carrusel de categorias del mockup.
  await expect(page.getByPlaceholder(/Busca eventos o artistas/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Conciertos" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Comedia" })).toBeVisible();

  // El evento del seed, no "el primero de la lista": otras specs corren en
  // paralelo y crean eventos publicados (E2E-*) que pueden caer antes. El
  // seed es el unico con localidad de pago, que es lo que ejercita este test.
  const row = page.locator(".home-list .home-row-main", { hasText: "Noche Electrónica" }).first();
  await expect(row).toBeVisible();
  const href = await row.getAttribute("href");
  expect(href).toMatch(/^\/evento\/\d+$/);
  await row.click();

  // Detalle: URL por id, datos clave y pestanas.
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByRole("tab", { name: "Descripción" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Lineup" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Ubicación" })).toBeVisible();
  await expect(page.locator(".evd-grid .evd-cell")).toHaveCount(3);

  // Lineup sin datos: estado honesto, no un bloque vacio.
  await page.getByRole("tab", { name: "Lineup" }).click();
  await expect(page.getByText("Lineup por anunciar.")).toBeVisible();

  // El CTA de compra se resuelve por tipo de evento. Con localidad de pago,
  // abre el checkout publico (modal); sin ella, lleva a Mis boletos.
  const buyLink = page.getByRole("link", { name: /Comprar boleto|Ver mis boletas/ });
  if (await buyLink.count()) {
    await buyLink.click();
    await expect(page).toHaveURL(/\/boletas$/);
    await expect(page.getByRole("heading", { name: "Mis boletas" })).toBeVisible();
  } else {
    await page.getByRole("button", { name: /Comprar boleto/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("Localidad")).toBeVisible();
  }
});

test("un evento inexistente muestra el estado no disponible", async ({ page }) => {
  const ok = await page
    .goto("/evento/99999999")
    .then(() => true)
    .catch(() => false);
  test.skip(!ok, "App no disponible");

  await expect(page.getByText("Este evento ya no está disponible.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Volver al inicio" })).toBeVisible();
});
