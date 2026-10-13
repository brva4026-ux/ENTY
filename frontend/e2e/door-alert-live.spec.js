/**
 * Regresión: el admin recibe el aviso de duplicados EN VIVO y salta a la noche.
 *
 * mig 026 convierte una ráfaga de reescaneos del mismo ticket (firma de un QR
 * reenviado) en una notificación in-app; mig 027 la enlaza a la noche exacta.
 * La campana es pasiva (hay que abrirla): este spec cubre la parte activa —
 * el banner que se planta encima del panel apenas llega el aviso, y el tap
 * que abre el backstage de ESA noche.
 *
 * La ráfaga se dispara por API (crear evento → live → emitir → 4 escaneos),
 * no con la cámara: el canje real exige HTTPS + cámara física, fuera del
 * alcance de un E2E. El aviso llega por el polling del feed (≤15 s).
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";
const ADMIN = { email: "admin@bar.test", password: "demo1234" };
const BOUNCER = { email: "puerta@bar.test", password: "demo1234" };

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

/** Noche EN PUERTA con QR escaneable + ráfaga de 3 duplicados del mismo ticket. */
async function triggerDoorAnomaly(request) {
  const admin = await apiLogin(request, ADMIN);
  const bouncer = await apiLogin(request, BOUNCER);
  const ah = { Authorization: `Bearer ${admin}` };
  const bh = { Authorization: `Bearer ${bouncer}` };

  const me = await (await request.get(`${BASE}/api/auth/me`, { headers: ah })).json();
  const venue = Number(Object.keys(me.roles)[0]);

  // +5 min y unlock 60: el QR ya está activo (ventana abierta) pero el evento
  // sigue siendo publicable; luego se abre a live.
  const starts = new Date(Date.now() + 5 * 60_000).toISOString();
  const ev = await (
    await request.post(`${BASE}/api/venues/${venue}/events`, {
      headers: ah,
      data: {
        name: `E2E-DOOR-${Date.now()}`,
        starts_at: starts,
        capacity: 50,
        qr_unlock_minutes: 60,
      },
    })
  ).json();
  const tipo = await (
    await request.post(`${BASE}/api/venues/${venue}/events/${ev.id}/types`, {
      headers: ah,
      data: { name: "Cortesia", price_cents: 0, quantity: 10, is_courtesy: true },
    })
  ).json();
  await request.post(`${BASE}/api/venues/${venue}/events/${ev.id}/publish`, { headers: ah });
  await request.post(`${BASE}/api/venues/${venue}/events/${ev.id}/live`, { headers: ah });
  const ticket = await (
    await request.post(`${BASE}/api/venues/${venue}/events/${ev.id}/tickets`, {
      headers: ah,
      data: {
        ticket_type_id: tipo.id,
        allocation_id: null,
        customer_name: "E2E",
        customer_phone: "3001234567",
      },
    })
  ).json();

  // 1 ingreso + 3 duplicados cruzan el umbral (3 en 5 min).
  for (let i = 0; i < 4; i++) {
    await request.post(`${BASE}/api/venues/${venue}/events/${ev.id}/redeem`, {
      headers: bh,
      data: { raw_token: ticket.raw_token },
    });
  }
  return ev.id;
}

test("el aviso de duplicados aparece en vivo y lleva a la noche", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await page.goto("/login");
  await page.locator("#login-email").fill(ADMIN.email);
  await page.locator("#login-password").fill(ADMIN.password);

  // El PRIMER poll del feed siembra los avisos existentes (no alerta por
  // historial). Lo esperamos ANTES de disparar la ráfaga para que el aviso
  // sea genuinamente nuevo — el escenario real, no un preexistente.
  const firstFeed = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith("/api/notifications") &&
      r.request().method() === "GET",
    { timeout: 15_000 },
  );
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/admin/, { timeout: 15_000 });
  await firstFeed;

  const eventId = await triggerDoorAnomaly(request);

  const banner = page.locator("[data-door-alert]");
  await expect(banner).toBeVisible({ timeout: 25_000 });
  await expect(banner).toContainText("Duplicados en puerta");

  // Un toque abre el backstage de ESA noche (no el panel a secas).
  await banner.getByRole("button", { name: "Ver la noche" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin\\?event=${eventId}`));
  // Al abrirlo se descarta (queda marcado como leído).
  await expect(banner).toHaveCount(0);
});
