/**
 * E2E del lado fan: Inicio (vitrina) -> detalle de evento -> Mis boletos.
 *
 * Es el camino publico sin login que estrena la app del fan:
 *  1. /inicio lista el catalogo real (seed demo) con buscador y categorias,
 *     y cada fila enlaza a su detalle.
 *  2. /evento/:id muestra el detalle publico (fecha, ubicacion, precio, CTA
 *     y pestanas). Un id inexistente cae al estado "no disponible", no a un
 *     crash.
 *  3. El CTA de compra lleva a /boletas (checkout publico todavia no existe).
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
  await expect(page.getByPlaceholder(/Busca conciertos/)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Conciertos" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Comedia" })).toBeVisible();

  // La primera fila de la lista lleva a su detalle publico.
  const firstRow = page.locator(".home-list .home-row-main").first();
  await expect(firstRow).toBeVisible();
  const href = await firstRow.getAttribute("href");
  expect(href).toMatch(/^\/evento\/\d+$/);
  await firstRow.click();

  // Detalle: URL por id, datos clave y pestanas.
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByRole("tab", { name: "Descripción" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Lineup" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Ubicación" })).toBeVisible();
  await expect(page.locator(".evd-grid .evd-cell")).toHaveCount(3);

  // Lineup sin datos: estado honesto, no un bloque vacio.
  await page.getByRole("tab", { name: "Lineup" }).click();
  await expect(page.getByText("Lineup por anunciar.")).toBeVisible();

  // El CTA de compra (aun sin checkout publico) lleva a Mis boletos.
  await page.getByRole("link", { name: /Comprar boleto/ }).click();
  await expect(page).toHaveURL(/\/boletas$/);
  await expect(page.getByRole("heading", { name: "Mis boletas" })).toBeVisible();
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
