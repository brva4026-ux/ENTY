/**
 * Regresión visual (Playwright `toHaveScreenshot`) — Fase 0 del plan estético.
 *
 * Congela las tres fuentes de no-determinismo para que la captura sea comparable
 * entre corridas y entre máquinas:
 *   1. Reloj fijo (`clock.setFixedTime`): las fechas relativas ("HOY", sellos de
 *      día, año del pie) dejan de depender del día en que corre la suite.
 *   2. Catálogo mockeado (`page.route`): la cartelera sale de un payload fijo, no
 *      del seed vigente, así el contenido (nombres, aforo, precios) no deriva.
 *   3. Animaciones apagadas: `tf_motion=reduce` (preferencia real de la app, ya
 *      soportada por el CSS) + `animations: "disabled"` de Playwright, que además
 *      cancela los bucles infinitos (aurora del login, banda cinética).
 *
 * La matriz es superficie × breakpoint × tema: público (portada y vitrina) y
 * auth, en móvil y escritorio, en oscuro y claro. Las líneas base viven en
 * `e2e/visual.spec.js-snapshots/` y se regeneran con `--update-snapshots`.
 *
 * Las líneas base se generan en la imagen oficial de Playwright (Ubuntu, mismo
 * SO que el runner de CI): un render de otro SO cambia el antialiasing de la
 * fuente y la comparación falla sin que la UI haya cambiado.
 */
import { expect, test } from "@playwright/test";

/** Reloj congelado: un lunes por la tarde en Bogotá (UTC-5). */
const FROZEN = new Date("2026-06-15T20:00:00.000Z");

/**
 * Catálogo fijo. Tres eventos: uno HOY (casi lleno, para el anillo de aforo),
 * uno en unos días y uno el mes siguiente. Sin flyer a propósito: la miniatura
 * cae en el sello de fecha (CSS puro, sin red ni imágenes que deriven).
 */
const EVENTS = {
  city: "Bar Esquina",
  count: 3,
  has_more: false,
  categories: ["Música", "Deportes", "Teatro", "Fiesta"],
  payments_enabled: true,
  events: [
    {
      id: 1,
      name: "Noche Electrónica",
      venue: "Bar Esquina",
      location: null,
      where: "Bar Esquina",
      starts_at: "2026-06-16T01:00:00.000Z",
      timezone: "America/Bogota",
      flyer_url: null,
      category: "Música",
      price_cents: 30000,
      sold_pct: 85,
      status: "published",
      contact_name: "Reservas Bar Esquina",
      contact_phone: "+57 300 123 4567",
    },
    {
      id: 2,
      name: "Clásico de la Ciudad",
      venue: "Estadio El Campín",
      location: null,
      where: "Estadio El Campín",
      starts_at: "2026-06-20T23:00:00.000Z",
      timezone: "America/Bogota",
      flyer_url: null,
      category: "Deportes",
      price_cents: 45000,
      sold_pct: 40,
      status: "published",
      contact_name: "Reservas Bar Esquina",
      contact_phone: "+57 300 123 4567",
    },
    {
      id: 3,
      name: "Noche de Teatro",
      venue: "Teatro Colón",
      location: null,
      where: "Teatro Colón",
      starts_at: "2026-07-04T23:30:00.000Z",
      timezone: "America/Bogota",
      flyer_url: null,
      category: "Teatro",
      price_cents: null,
      sold_pct: 12,
      status: "published",
      contact_name: "Reservas Bar Esquina",
      contact_phone: "+57 300 123 4567",
    },
  ],
};

/** Rutas del catálogo: lista (portada y vitrina) y detalle (por si se navega). */
async function mockCatalog(page) {
  await page.route("**/api/public/events**", (route) => {
    const url = new URL(route.request().url());
    const detail = /\/events\/\d+$/.test(url.pathname);
    if (detail) {
      const id = Number(url.pathname.split("/").pop());
      const ev = EVENTS.events.find((e) => e.id === id) ?? EVENTS.events[0];
      return route.fulfill({ json: { ...ev, ticket_types: [], lineup: [], sold_out: false } });
    }
    return route.fulfill({ json: EVENTS });
  });
}

/** Siembra las preferencias antes del primer paint y fija el reloj. */
async function prepare(page, theme) {
  await page.clock.setFixedTime(FROZEN);
  await page.addInitScript((t) => {
    try {
      // Aviso de cookies fuera de la captura: es un banner de primer arranque,
      // no parte de la superficie que se compara.
      localStorage.setItem("tf_cookie_notice", "1.1");
      // Apaga animaciones y transiciones desde el primer frame (el CSS ya lo
      // respeta): la captura no depende de dónde cayó una cascada de entrada.
      localStorage.setItem("tf_motion", "reduce");
      localStorage.setItem("tf_theme", t);
    } catch {
      /* sin storage la captura falla igual, pero el error es más claro arriba */
    }
  }, theme);
  await mockCatalog(page);
}

/** Espera a que la superficie esté montada, con las fuentes cargadas. */
async function settle(page, selector) {
  await page.waitForSelector(selector, { state: "visible", timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

/**
 * Superficies a capturar. `themes` declara la sensibilidad real al tema: la
 * portada y la vitrina del fan son "papel" (lienzo claro propio, ver
 * landing.css / enty-fan.css) y NO voltean con `data-theme`; el login sí
 * (panel de marca navy en oscuro, tarjeta clara en claro). Capturar un tema
 * que no cambia el render solo duplicaría líneas base idénticas y escondería
 * que el tema no aplica ahí.
 */
const SURFACES = [
  { name: "portada", path: "/", anchor: ".lp", themes: ["light"] },
  { name: "vitrina", path: "/inicio", anchor: ".home", themes: ["light"] },
  { name: "login", path: "/login", anchor: ".login-page", themes: ["dark", "light"] },
];

const BREAKPOINTS = [
  { name: "movil", viewport: { width: 420, height: 860 } },
  { name: "escritorio", viewport: { width: 1280, height: 900 } },
];

for (const bp of BREAKPOINTS) {
  test.describe(`${bp.name} (${bp.viewport.width}×${bp.viewport.height})`, () => {
    test.use({ viewport: bp.viewport });

    for (const surface of SURFACES) {
      for (const theme of surface.themes) {
        test(`${surface.name} — ${theme}`, async ({ page }) => {
          const ok = await page
            .goto(surface.path)
            .then((r) => !!r && r.status() < 500)
            .catch(() => false);
          test.skip(!ok, "App no disponible");

          await prepare(page, theme);
          await page.goto(surface.path);
          await settle(page, surface.anchor);

          await expect(page).toHaveScreenshot(
            `${surface.name}-${bp.name}-${theme}.png`,
            {
              animations: "disabled",
              caret: "hide",
              // Antialiasing de la fuente: un píxel de borde no debe tumbar la
              // comparación, pero un cambio de layout (muchos píxeles) sí.
              maxDiffPixels: 120,
            },
          );
        });
      }
    }
  });
}
