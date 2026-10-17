/**
 * E2E del modo offline de puerta (service worker).
 *
 * Por que existe: el modo offline es la funcion critica del producto (la
 * puerta sin red), pero NO tenia ni un test. El registro del SW vivia tras un
 * guard que exigia `localhost` o https, y el E2E corre en 127.0.0.1: el SW
 * nunca se registraba ahi, asi que una rotura del offline pasaba inadvertida.
 * El guard ahora usa window.isSecureContext (cubre 127.0.0.1); este spec fija
 * ese contrato.
 *
 * Que comprueba:
 *  1. El SW se registra y ACTIVA en el host del E2E (la regresion original).
 *  2. Sin red, una navegacion sirve el app shell desde el cache (la puerta
 *     abre aunque el venue se quede sin internet).
 *  3. La API NO se cachea nunca (aforo y boletas deben ser datos vivos).
 *
 * Requiere E2E_BASE_URL (default http://127.0.0.1:8001). Se salta solo si el
 * backend no responde, igual que el resto de specs.
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";

test.beforeEach(async ({ request }) => {
  let ok = false;
  try {
    ok = (await request.get(`${BASE}/api/health`)).ok();
  } catch {
    ok = false;
  }
  test.skip(!ok, `Backend no disponible en ${BASE}`);
});

/** Espera a que el SW tome control de la pagina (requiere una recarga). */
async function controlarServiceWorker(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), {
      timeout: 15_000,
    })
    .toBe(true);
}

test("el service worker se registra y activa en el host del E2E", async ({
  page,
}) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });

  // isSecureContext es true en https, localhost y 127.0.0.1: el guard del
  // registro depende de esto, no del hostname.
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);

  // OJO: page.evaluate NO puede devolver un ServiceWorkerRegistration (no es
  // serializable: Playwright lo entrega como {}). Hay que extraer el estado
  // dentro del evaluate y devolver un primitivo.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration();
          return reg?.active?.state || null;
        }),
      { timeout: 15_000 },
    )
    .toBe("activated");
});

test("sin red, la puerta abre el app shell desde el cache", async ({
  page,
  context,
}) => {
  await page.goto("/bouncer", { waitUntil: "domcontentloaded" });
  await controlarServiceWorker(page);

  await context.setOffline(true);

  // Con el SW activo la navegacion se resuelve desde el cache. Sin el, esto
  // lanzaria ERR_INTERNET_DISCONNECTED: esa es la diferencia que protege el
  // test.
  const res = await page.goto("/bouncer", { waitUntil: "domcontentloaded" });
  // 200 = shell real desde el cache. El SW devuelve 503 con "Sin conexión"
  // cuando no encuentra nada en cache, asi que el status es el discriminador
  // (el texto no sirve: OfflineBanner muestra "Sin conexión..." legitimamente).
  expect(res?.status()).toBe(200);

  const texto = await page.evaluate(() => document.body.innerText);
  expect(texto.trim().length).toBeGreaterThan(0);

  await context.setOffline(false);
});

test("la API nunca se sirve desde el cache", async ({ page, context }) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await controlarServiceWorker(page);

  // En linea: la respuesta entra en la cache HTTP del navegador y el SW la ve.
  const enLinea = await page.evaluate(
    async () => (await fetch("/api/health")).status,
  );
  expect(enLinea).toBe(200);

  await context.setOffline(true);

  // Aunque /api/health se pidio antes, el handler del SW ignora /api/: la
  // peticion sin red debe FALLAR, no resolverse con datos viejos de aforo.
  const sinRed = await page.evaluate(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      return { ok: true, status: r.status };
    } catch {
      return { ok: false };
    }
  });
  expect(sinRed.ok).toBe(false);

  await context.setOffline(false);
});
