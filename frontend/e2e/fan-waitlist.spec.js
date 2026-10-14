/**
 * Regresión: el evento AGOTADO ofrece la lista de espera (E2, ciclo DICE).
 *
 * El detalle publico decide la accion segun `sold_out` (mismo gate que
 * `join_waitlist`): con lugar, "Comprar boleto"; sin lugar, "Entrar a la lista
 * de espera" -> /waitlist?event=<id> con el evento ya precargado. El fan entra
 * con nombre + telefono y ve su posicion. Sin cuentas, como todo el publico.
 *
 * El agotado se arma por API (evento chico + emitir todo), no con la camara:
 * el flujo de compra real exige Wompi.
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";
const ADMIN = { email: "admin@bar.test", password: "demo1234" };

test.beforeEach(async ({ request }) => {
  try {
    const res = await request.get(`${BASE}/api/health`);
    test.skip(!res.ok(), `Backend no disponible en ${BASE}`);
  } catch {
    test.skip(true, `Backend no disponible en ${BASE}`);
  }
});

async function apiLogin(request, { email, password }) {
  const res = await request.post(`${BASE}/api/auth/login`, {
    data: { email, password },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).access_token;
}

/** Evento publicado y futuro, agotado: cupo 2, ambas boletas emitidas. */
async function makeEvent(request, { capacity, emit }) {
  const admin = await apiLogin(request, ADMIN);
  const ah = { Authorization: `Bearer ${admin}` };
  const me = await (await request.get(`${BASE}/api/auth/me`, { headers: ah })).json();
  const venue = Number(Object.keys(me.roles)[0]);

  const starts = new Date(Date.now() + 29 * 60 * 60_000).toISOString();
  const ev = await (
    await request.post(`${BASE}/api/venues/${venue}/events`, {
      headers: ah,
      data: {
        name: `E2E-WAIT-${Date.now()}`,
        starts_at: starts,
        capacity,
        location: `CiudadWait${Date.now()}`,
      },
    })
  ).json();
  const tipo = await (
    await request.post(`${BASE}/api/venues/${venue}/events/${ev.id}/types`, {
      headers: ah,
      data: {
        name: "General",
        price_cents: 5000000,
        quantity: capacity,
        is_courtesy: false,
      },
    })
  ).json();
  await request.post(`${BASE}/api/venues/${venue}/events/${ev.id}/publish`, {
    headers: ah,
  });
  for (let i = 0; i < emit; i++) {
    await request.post(`${BASE}/api/venues/${venue}/events/${ev.id}/tickets`, {
      headers: ah,
      data: {
        ticket_type_id: tipo.id,
        allocation_id: null,
        customer_name: `E2E ${i}`,
        customer_phone: `30012345${i}${Date.now() % 100}`,
      },
    });
  }
  return ev.id;
}

test("un evento agotado lleva a la lista de espera con el evento precargado", async ({
  page,
  request,
}) => {
  const eventId = await makeEvent(request, { capacity: 2, emit: 2 });

  await page.goto(`/evento/${eventId}`);
  const cta = page.getByRole("link", { name: "Entrar a la lista de espera" });
  await expect(cta).toBeVisible({ timeout: 15_000 });
  await cta.click();

  await expect(page).toHaveURL(new RegExp(`/waitlist\\?event=${eventId}`));
  const eventField = page.getByPlaceholder("Link del evento o su número");
  await expect(eventField).toHaveValue(String(eventId));

  await page.getByPlaceholder("Nombre y apellido").fill("Fan Espera");
  await page.getByPlaceholder("300 000 0000").fill("573001112233");
  await page.getByRole("button", { name: "Entrar a la fila" }).click();

  await expect(page.getByText(/Vas en la posición/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(".tnum", { hasText: "#1" })).toBeVisible();
});

test("un evento con lugar sigue ofreciendo comprar boleto", async ({
  page,
  request,
}) => {
  const eventId = await makeEvent(request, { capacity: 50, emit: 0 });

  await page.goto(`/evento/${eventId}`);
  await expect(page.getByRole("button", { name: "Comprar boleto" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("link", { name: "Entrar a la lista de espera" }),
  ).toHaveCount(0);
});
