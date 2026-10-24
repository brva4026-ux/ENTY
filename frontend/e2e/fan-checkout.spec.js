/**
 * Regresión: el fan COMPRA solo (checkout publico, sin cuenta).
 *
 * Antes el CTA "Comprar boleto" solo llevaba a "Mis boletas": no existia forma
 * de pagar sin que el bar emitiera la boleta a mano. Ahora el CTA abre un
 * checkout que crea el cobro en Wompi (el dinero entra primero) y devuelve la
 * URL de pago. Este spec fija que:
 *  - un evento CON localidad de pago muestra el CTA que abre el checkout;
 *  - el checkout trae localidad + contacto y el boton de pagar con el precio.
 *
 * El POST real a Wompi se STUBBEA (no hay claves en el entorno de test): lo
 * que se prueba es el cableado de la UI, no la pasarela (eso lo cubre
 * backend/tests/test_public_checkout.py contra la DB y el webhook reales).
 *
 * Corre contra backend REAL con seed demo (E2E_BASE_URL). Sin app, se salta.
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

/** Evento del catalogo con localidad de pago (precio > 0) y lugar libre.
 *
 * Se prefiere el evento del seed ("Noche Electrónica"): es estable y es el
 * unico que el test controla. Otras specs corren en paralelo y dejan eventos
 * E2E-* publicados que caen antes en el catalogo; los de la lista de espera
 * estan agotados (sold_pct 100) y su CTA es "Entrar a la lista de espera", no
 * "Comprar boleto", asi que tambien se descartan por sold_pct. El listado
 * publico no expone `sold_out` (solo el detalle), por eso el proxy es
 * `sold_pct`. */
async function pricedEventId(request) {
  const events = await (
    await request.get(`${BASE}/api/public/events?limit=100`)
  ).json();
  const list = events.events || events;
  const priced = list.filter((e) => (e.price_cents || 0) > 0);
  const ev =
    priced.find((e) => e.name === "Noche Electrónica") ||
    priced.find((e) => (e.sold_pct ?? 0) < 100) ||
    priced[0];
  test.skip(!ev, "El seed demo no tiene eventos con localidad de pago");
  return ev.id;
}

test("el fan compra una boleta sin cuenta", async ({ page, request }) => {
  const eventId = await pricedEventId(request);

  // Stub del POST de checkout: devuelve una URL de pago falsa en vez de ir a
  // Wompi (no hay claves en CI). El resto de la app queda intacto.
  await page.route("**/api/public/events/*/checkout", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        reference: "TF-1-stub",
        payment_url: "https://checkout.wompi.co/l/stub",
        amount_in_cents: 5000000,
        event_id: eventId,
        event_name: "Stub",
        status: "pending",
      }),
    });
  });
  // Stub de la pagina de Wompi: si el fan llega ahi, es que la app redirigio.
  await page.route("**/checkout.wompi.co/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Wompi</title>pago",
    }),
  );

  await page.goto(`/evento/${eventId}`);

  // El CTA de compra abre el checkout (evento con precio de pago).
  const cta = page.getByRole("button", { name: /Comprar boleto/ });
  await expect(cta).toBeVisible({ timeout: 15_000 });
  await cta.click();

  // El modal trae la localidad, el contacto y el boton de pagar con el precio.
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Localidad")).toBeVisible();
  await expect(page.getByRole("option", { name: /General/ })).toBeAttached();
  await expect(page.getByRole("button", { name: /Pagar/ })).toBeVisible();

  // Llenar y enviar: con nombre + telefono, el submit crea el cobro (stub) y
  // la app redirige al checkout de Wompi.
  await page.getByLabel(/Tu nombre/).fill("Fan De Prueba");
  await page.getByLabel(/Teléfono/).fill("3001234567");
  await page.getByRole("button", { name: /Pagar/ }).click();

  await page.waitForURL(/checkout\.wompi\.co/, { timeout: 10_000 });
});
