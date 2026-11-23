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

  // El catálogo real decide qué evento abrir. Otras specs corren en paralelo
  // y crean eventos publicados (E2E-*), así que no se puede clavar un nombre
  // del seed; se elige uno con precio para ejercitar el checkout.
  const event = await page.evaluate(async () => {
    const res = await fetch("/api/public/events?limit=100")
      .then((r) => r.json())
      .catch(() => null);
    const list = res?.events || [];
    return (
      list.find(
        (e) => (e.price_cents || 0) > 0 && (e.sold_pct ?? 0) < 100,
      ) || null
    );
  });
  test.skip(!event, "Sin evento con localidad de pago");

  // El detalle se fuerza a `payments_enabled` para que el CTA sea el botón
  // de compra (el seed local no tiene Wompi configurado).
  await page.route("**/api/public/events/*", async (route) => {
    const url = route.request().url();
    if (!/\/events\/\d+(\?|$)/.test(url)) return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    body.payments_enabled = true;
    await route.fulfill({ response: res, json: body });
  });

  // Si la fila está en la vitrina, se navega por ella; si el catálogo tiene
  // más de 100 eventos y la fila quedó fuera, se entra directo por id.
  const row = page
    .locator(".home-list .home-row-main", { hasText: event.name })
    .first();
  if (await row.count()) {
    await row.click();
  } else {
    await page.goto(`/evento/${event.id}`);
  }

  // Detalle: URL por id, datos clave en texto y secciones de la ficha.
  await expect(page).toHaveURL(new RegExp(`/evento/${event.id}$`));
  await expect(page.locator(".evd-title")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Boletas" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lugar" })).toBeVisible();
  await expect(page.locator(".evd-grid .evd-cell")).toHaveCount(3);
  // La fecha y el lugar no viven solo en la imagen: se leen como texto.
  await expect(page.locator(".evd-when")).toContainText(/\d/);
  await expect(page.locator(".evd-where")).not.toBeEmpty();

  // Con precio y pago habilitado, el rail abre el checkout público.
  await page
    .locator(".evd-buy")
    .getByRole("button", { name: /Comprar boleto/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Localidad")).toBeVisible();
});

test("la ficha muestra video, mapa confirmado y contacto del evento", async ({
  page,
}) => {
  const ok = await page
    .goto("/inicio")
    .then(() => true)
    .catch(() => false);
  test.skip(!ok, "App no disponible");

  const event = {
    id: 1,
    name: "Fiesta de prueba",
    description: "Una noche de prueba.",
    flyer_url: null,
    location: "Calle 45 #12-30",
    venue: "Club Demo",
    starts_at: "2030-03-01T20:00:00+00:00",
    timezone: "America/Bogota",
    category: "Conciertos",
    price_cents: 3000000,
    sold_pct: 20,
    sold_out: false,
    status: "published",
    waiting_room: false,
    min_age: 18,
    dress_code: "Elegante",
    doors_open_at: null,
    contact_name: "Productora Norte",
    contact_phone: "573001112233",
    ticket_types: [
      {
        id: 1,
        name: "General",
        price_cents: 3000000,
        quantity: 100,
        is_courtesy: false,
        sold_out: false,
      },
    ],
    lineup: [],
    payments_enabled: false,
    video_url: "https://93.184.216.34/clip.mp4",
    location_url: "https://maps.example.com/evento",
  };
  await page.route("**/api/public/events/1", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(event),
    }),
  );
  await page.goto("/evento/1");

  await expect(page.getByRole("heading", { name: "Video del evento" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Reproducir video de Fiesta de prueba/ }),
  ).toBeVisible();
  await expect(page.getByText("Ver video del evento")).toBeVisible();
  await expect(page.getByRole("link", { name: "Cómo llegar" })).toHaveAttribute(
    "href",
    "https://maps.example.com/evento",
  );
  await expect(page.getByText("Contactar al organizador")).toBeVisible();
  await expect(page.getByText("Productora Norte")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Boletas" })).toBeVisible();
});

test("un evento sin precio no manda a Mis boletas", async ({ page }) => {
  const event = {
    id: 7,
    name: "Tarde de teatro",
    description: "Entrada libre hasta completar aforo.",
    flyer_url: null,
    video_url: null,
    location: "Casa de la Cultura",
    venue: "Casa de la Cultura",
    starts_at: "2030-04-12T20:00:00+00:00",
    timezone: "America/Bogota",
    category: "Teatro",
    price_cents: null,
    payments_enabled: false,
    sold_pct: 10,
    sold_out: false,
    status: "published",
    waiting_room: false,
    contact_name: null,
    contact_phone: null,
    ticket_types: [],
    lineup: [],
  };
  await page.route("**/api/public/events/7", (route) =>
    route.fulfill({ json: event }),
  );

  const ok = await page
    .goto("/evento/7")
    .then(() => true)
    .catch(() => false);
  test.skip(!ok, "App no disponible");

  await expect(page.getByRole("heading", { name: "Boletas" })).toBeVisible();
  await expect(page.getByText("Entrada gratuita")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Ver mis boletas" }),
  ).toHaveCount(0);
});

test("un evento inexistente muestra el estado no disponible", async ({ page }) => {
  await page.route("**/api/public/events/99999999", (route) =>
    route.fulfill({ status: 404, json: { detail: "Evento no encontrado" } }),
  );
  const ok = await page
    .goto("/evento/99999999")
    .then(() => true)
    .catch(() => false);
  test.skip(!ok, "App no disponible");

  await expect(page.getByText("Este evento ya no está disponible.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Volver al inicio" })).toBeVisible();
});

test.describe("Mis boletas: el aviso no promete un correo que no sale", () => {
  // El titulo era fijo ("Revisa tu correo") aunque Resend no estuviera
  // configurado: la pantalla prometia un envio que nunca ocurre, justo encima
  // del texto que decia que se lo pidiera al organizador.
  test("sin correo configurado, no manda a revisar el correo", async ({ page }) => {
    await page.route("**/api/public/my-tickets", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Si ese contacto tiene boletas, te enviamos un enlace.",
          email_configured: false,
        }),
      }),
    );
    await page.goto("/boletas");
    await page.getByLabel(/Correo o teléfono/i).fill("fan@bar.test");
    await page.getByRole("button", { name: /Enviar enlace/i }).click();

    const aviso = page.getByRole("status");
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText(/no envía correos/i);
    await expect(aviso).not.toContainText(/revisa tu correo/i);
  });

  test("con correo configurado, si invita a revisarlo", async ({ page }) => {
    await page.route("**/api/public/my-tickets", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Si ese contacto tiene boletas, te enviamos un enlace.",
          email_configured: true,
        }),
      }),
    );
    await page.goto("/boletas");
    await page.getByLabel(/Correo o teléfono/i).fill("fan@bar.test");
    await page.getByRole("button", { name: /Enviar enlace/i }).click();

    const aviso = page.getByRole("status");
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText(/revisa tu correo/i);
  });
});
