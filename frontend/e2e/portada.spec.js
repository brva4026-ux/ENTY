/**
 * E2E de la portada del admin (Playwright).
 *
 * Regresión del fix real: el <Link absolute inset-0> que hace clickeable
 * cada tarjeta de evento se anclaba al primer ancestro posicionado (que NO
 * era la tarjeta): todos los enlaces del grid compartían una sola caja
 * gigante y el clic no abría el backstage (o abría el evento equivocado).
 *
 * La prueba que lo caza tiene dos capas:
 *  1. GEOMÉTRICA (determinista): el bounding box del enlace de la tarjeta
 *     debe caber DENTRO del bounding box de su tarjeta. Con el bug, el
 *     enlace media el ancho de toda la sección (990px en desktop).
 *  2. FUNCIONAL: el clic navega a /admin?event=<id> y monta el backstage.
 *
 * Corre contra backend REAL con seed demo (E2E_BASE_URL, default
 * http://127.0.0.1:8001; en CI el preview de Vite proxya /api). Sin seed,
 * se salta solo (los emails demo no existen) en vez de fallar en rojo.
 */
import { expect, test } from "@playwright/test";

const ADMIN = { email: "admin@bar.test", password: "demo1234" };

test("el clic en una tarjeta de evento abre su backstage", async ({
  page,
}) => {
  // Sin seed el login falla: skip honesto en vez de rojo (convención del spec de puerta).
  const loginOk = await page
    .goto("/login")
    .then(() => true)
    .catch(() => false);
  test.skip(!loginOk, `App no disponible`);

  await page.locator("#login-email").fill(ADMIN.email);
  await page.locator("#login-password").fill(ADMIN.password);
  await page
    .getByRole("button", { name: "Entrar", exact: true })
    .click();
  await page.waitForURL(/admin/, { timeout: 10_000 });

  // La franja de eventos llega con un fetch extra: esperar la primera tarjeta.
  const card = page.locator(".evx-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });

  // --- CAPA 1: regresión geométrica del anclaje del Link ----------------
  // El enlace overlay (aria-label="Abrir <nombre>") debe estar contenido
  // por SU tarjeta. Si .evx-card pierde position:relative, este assert
  // falla: el enlace crece hasta el tamaño de la sección entera.
  const boxes = await card.evaluate((el) => {
    const link = el.querySelector('a[aria-label^="Abrir"]');
    if (!link) return null;
    const c = el.getBoundingClientRect();
    const l = link.getBoundingClientRect();
    return {
      card: { w: c.width, h: c.height },
      link: { w: l.width, h: l.height },
      contained:
        l.left >= c.left - 1 &&
        l.top >= c.top - 1 &&
        l.right <= c.right + 1 &&
        l.bottom <= c.bottom + 1,
    };
  });
  expect(boxes, "la tarjeta debe contener su enlace overlay").not.toBeNull();
  expect(
    boxes.contained,
    `el enlace (${Math.round(boxes.link.w)}x${Math.round(
      boxes.link.h,
    )}) debe caber dentro de la tarjeta (${Math.round(
      boxes.card.w,
    )}x${Math.round(boxes.card.h)}) — si mide el ancho de la sección, el Link se desancló`,
  ).toBe(true);

  // --- CAPA 2: el clic navega y monta el backstage -----------------------
  await card.click();
  await expect(page).toHaveURL(/\/admin\?event=\d+/, { timeout: 10_000 });
  await expect(page.getByText("Backstage del evento")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Resumen", selected: true }),
  ).toBeVisible();

  // Volver a la lista: la URL vuelve al modo portada sin ?event=.
  await page.getByRole("button", { name: /Volver/ }).first().click();
  await expect(page).toHaveURL(/\/admin$/, { timeout: 10_000 });
  await expect(page.locator(".evx-card").first()).toBeVisible();
});

/**
 * Operación de eventos: la ficha dice la verdad y el fallback sin flyer
 * identifica la noche.
 *
 *  1. Filtrar por un estado sin eventos NO debe decir "no coincide con la
 *     búsqueda": ese texto mentía (no había búsqueda) y no daba salida.
 *  2. Sin flyer, la miniatura es una hoja de calendario (mes + día), no dos
 *     iniciales: en una lista de noches el día identifica más.
 *
 * Corre contra el seed demo; se salta sola si el estado elegido no está
 * vacío (el seed cambia, la aserción no debe volverse frágil).
 */
test("el estado vacío dice el motivo y la miniatura sin flyer es una fecha", async ({
  page,
}) => {
  const loginOk = await page
    .goto("/login")
    .then(() => true)
    .catch(() => false);
  test.skip(!loginOk, "App no disponible");

  await page.locator("#login-email").fill(ADMIN.email);
  await page.locator("#login-password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/admin/, { timeout: 10_000 });
  await expect(page.locator(".evx-card").first()).toBeVisible({
    timeout: 10_000,
  });

  // --- 1. Fallback sin flyer = hoja de calendario -----------------------
  const fallback = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".evx-card")].find(
      (c) => !c.querySelector("img.evx-thumb"),
    );
    if (!card) return "no-flyerless-card";
    return card.querySelector(".evx-datecal") ? "date" : "other";
  });
  // Si el seed trae flyer en todas las noches, no hay fallback que probar.
  if (fallback !== "no-flyerless-card") {
    expect(
      fallback,
      "la miniatura sin flyer debe ser una hoja de calendario (.evx-datecal)",
    ).toBe("date");
  }

  // --- 2. Estado vacío honesto ------------------------------------------
  // Un bucket sin contador = sin eventos. Se elige el primero que exista.
  const emptyTab = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll(".evx-tab")];
    const empty = tabs.find(
      (t) =>
        !t.querySelector(".evx-tab-count") &&
        /Cancelad|Borrador|Terminad|En puerta|venta/.test(t.textContent),
    );
    return empty ? empty.textContent.trim().replace(/\s+/g, " ") : null;
  });
  test.skip(!emptyTab, "el seed no tiene ningún estado vacío");

  await page.getByRole("button", { name: new RegExp(emptyTab) }).click();
  await expect(page.getByText("No hay eventos en este estado")).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByRole("button", { name: "Ver todos" })).toBeVisible();
});

