/**
 * Guardarraíl de la LEY DE PROXIMIDAD (Gestalt) — Playwright.
 *
 * La distancia ES la que comunica la pertenencia: dos cosas que van juntas se
 * leen juntas si el hueco entre ellas es claramente menor que el hueco hacia
 * lo que viene después. Esta spec no fija píxeles exactos (eso lo hace el
 * diseño); fija la RELACIÓN, que es lo que el ojo percibe y lo que se rompe
 * cuando alguien "arregla" un margen a ojo.
 *
 * Corre contra el app shell real (E2E_BASE_URL, default 127.0.0.1:8001) con el
 * seed demo; si la app no responde, se salta sola.
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

test("vitrina /inicio: el buscador y las categorías son UN grupo", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/inicio");
  test.skip(!ok, "App no disponible");
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
  await page.waitForTimeout(400);

  const r = await page.evaluate(() => {
    const box = (s) => {
      const e = document.querySelector(s);
      return e ? e.getBoundingClientRect() : null;
    };
    const gap = (a, b) => {
      const A = box(a), B = box(b);
      return A && B ? Math.round(B.top - A.bottom) : null;
    };
    return {
      heroSearch: gap(".home-hero", ".home-search"),
      searchCats: gap(".home-search", ".home-cats"),
      catsTicker: gap(".home-cats", ".home-ticker"),
      tickerGrid: gap(".home-ticker", ".home-grid"),
    };
  });
  await ctx.close();

  expect(r.searchCats, "el buscador y las categorías deben existir").not.toBeNull();
  // El grupo "decidir qué ver" (buscador + categorías) tiene un hueco interno
  // chico; hacia el titular y hacia el resultado el hueco es de sección.
  expect(
    r.heroSearch,
    `el titular no puede estar tan pegado al buscador (${r.heroSearch}px) como el buscador a las categorías (${r.searchCats}px)`
  ).toBeGreaterThan(r.searchCats);
  if (r.catsTicker !== null) {
    expect(
      r.catsTicker,
      `la banda cinética abre la región: debe separarse (${r.catsTicker}px) más que el grupo interno (${r.searchCats}px)`
    ).toBeGreaterThan(r.searchCats);
  }
});

test("vitrina /inicio: la lista no queda pegada a su encabezado", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/inicio");
  test.skip(!ok, "App no disponible");
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
  await page.waitForTimeout(400);

  const r = await page.evaluate(() => {
    const sub = document.querySelector(".home-subhead");
    const list = document.querySelector(".home-list");
    if (!sub || !list) return null;
    return {
      filas: document.querySelectorAll(".home-row").length,
      gap: Math.round(list.getBoundingClientRect().top - sub.getBoundingClientRect().bottom),
      mt: parseFloat(getComputedStyle(list).marginTop),
    };
  });
  await ctx.close();

  // Con un solo evento no hay encabezado de lista (ya lo cubre a11y.spec.js).
  if (!r || r.filas === 0) return;
  expect(
    r.mt,
    `"Próximos" y su lista son un bloque: el hueco (${r.mt}px) debe ser chico, no de sección`
  ).toBeLessThanOrEqual(16);
});

test("detalle de evento: la cabecera (rubro+título+resumen) es un bloque", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/inicio");
  test.skip(!ok, "App no disponible");

  // El catálogo real decide qué evento abrir; el primero sirve.
  const id = await page.evaluate(async () => {
    const res = await fetch("/api/public/events").then((x) => x.json()).catch(() => null);
    return res?.events?.[0]?.id ?? null;
  });
  test.skip(!id, "Sin catálogo público");

  await page.goto(`/evento/${id}`);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
  await page.waitForTimeout(400);

  const r = await page.evaluate(() => {
    const box = (s) => {
      const e = document.querySelector(s);
      return e ? e.getBoundingClientRect() : null;
    };
    const gap = (a, b) => {
      const A = box(a), B = box(b);
      return A && B ? Math.round(B.top - A.bottom) : null;
    };
    return {
      eyebrowTitle: gap(".evd-eyebrow", ".evd-title"),
      titleSub: gap(".evd-title", ".evd-sub"),
      subGrid: gap(".evd-sub", ".evd-grid"),
    };
  });
  await ctx.close();

  expect(r.eyebrowTitle, "la cabecera del detalle debe existir").not.toBeNull();
  expect(r.subGrid, "el cuerpo del detalle debe existir").not.toBeNull();
  // Rubro → título → resumen van juntos; el cuerpo es otra sección.
  expect(r.eyebrowTitle, "rubro y título son el mismo bloque").toBeLessThanOrEqual(12);
  expect(r.titleSub, "título y resumen son el mismo bloque").toBeLessThanOrEqual(12);
  expect(
    r.subGrid,
    `el cuerpo debe abrir sección (${r.subGrid}px), no leerse como parte de la cabecera`
  ).toBeGreaterThan(r.titleSub);
});

test("login: la etiqueta pertenece a su campo", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/login");
  test.skip(!ok, "App no disponible");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
  await page.waitForTimeout(300);

  const r = await page.evaluate(() => {
    const lab = document.querySelector(".auth-label");
    const field = document.querySelector(".auth-field");
    const form = document.querySelector(".auth-login-form");
    if (!lab || !field || !form) return null;
    return {
      labelField: Math.round(field.getBoundingClientRect().top - lab.getBoundingClientRect().bottom),
      subForm: Math.round(form.getBoundingClientRect().top - (document.querySelector(".auth-login-sub")?.getBoundingClientRect().bottom ?? 0)),
    };
  });
  await ctx.close();

  expect(r, "el formulario de acceso debe existir").not.toBeNull();
  expect(r.labelField, "la etiqueta va pegada a su campo").toBeLessThanOrEqual(10);
  expect(
    r.subForm,
    `el bloque del formulario debe separarse (${r.subForm}px) más que la etiqueta de su campo (${r.labelField}px)`
  ).toBeGreaterThan(r.labelField);
});

test("panel: los instrumentos se separan más que sus partes internas", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/login");
  test.skip(!ok, "App no disponible");
  await login(page, "admin@bar.test");
  // Los instrumentos viven en la pestaña "Puerta" del negocio (solo con una
  // noche en vivo). El seed demo deja una abierta.
  await page.goto("/admin/negocio?tab=puerta");
  await page.waitForTimeout(2000);

  const r = await page.evaluate(() => {
    const grid = document.querySelector(".pc-instruments");
    const card = document.querySelector(".pc-dcard");
    if (!grid || !card) return null;
    const cs = getComputedStyle(grid);
    return {
      gridGap: parseFloat(cs.rowGap || cs.gap),
      cardPad: parseFloat(getComputedStyle(card).paddingLeft),
    };
  });
  await ctx.close();

  test.skip(!r, "El seed demo no dejó una noche en vivo");
  expect(
    r.gridGap,
    `tarjeta<->tarjeta (${r.gridGap}px) debe separarse al menos como su padding interno (${r.cardPad}px)`
  ).toBeGreaterThanOrEqual(12);
});

test("panel: los controles de la cabecera del negocio van agrupados", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/login");
  test.skip(!ok, "App no disponible");
  await login(page, "admin@bar.test");
  await page.waitForTimeout(2000);

  const r = await page.evaluate(() => {
    const id = document.querySelector(".vh-identidad");
    const nombre = document.querySelector(".vh-nombre");
    const top = document.querySelector(".vh-top");
    if (!id || !nombre || !top) return null;
    const cs = (el) => parseFloat(getComputedStyle(el).rowGap || getComputedStyle(el).gap);
    return {
      identidadGap: cs(id),
      nombreGap: cs(nombre),
      topGap: cs(top),
    };
  });
  await ctx.close();

  if (!r) test.skip(true, "La portada del negocio no renderizó la identidad");
  // El tile y su wordmark van juntos; la identidad y el KPI son bloques.
  expect(
    r.identidadGap,
    `el tile y el nombre del negocio van juntos (${r.identidadGap}px)`
  ).toBeLessThanOrEqual(16);
  expect(
    r.topGap,
    `la identidad y el KPI son bloques distintos: deben separarse (${r.topGap}px) más que el lockup interno (${r.identidadGap}px)`
  ).toBeGreaterThan(r.identidadGap);
});
