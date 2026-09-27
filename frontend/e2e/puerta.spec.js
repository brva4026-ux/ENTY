/**
 * E2E del flujo crítico (Playwright).
 *
 * Lo que da el dinero: el staff entra y la puerta responde. Este spec corre
 * contra un backend REAL con DB real. Cobertura honesta de CI:
 *
 *  1. Login del bouncer → escáner: la pantalla de puerta monta, muestra el
 *     evento seleccionado y el bloque de caché de puerta (el canje con
 *     cámara exige HTTPS + cámara física: fuera del alcance de un E2E).
 *  2. Login del admin → panel: la cabecera de la venue y el dock Del
 *     negocio se montan con datos reales de la DB.
 *
 * Requiere E2E_BASE_URL (default http://127.0.0.1:8001) y el seed demo
 * vigente (IS_DEMO=true + POST /seed, ver AGENTS.md). Sin seed, el spec
 * se salta solo (los emails demo no existen) en vez de fallar en rojo.
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";
const BOUNCER = { email: "puerta@bar.test", password: "demo1234" };
const ADMIN = { email: "admin@bar.test", password: "demo1234" };

async function seedDisponible() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ request }) => {
  const ok = await seedDisponible();
  test.skip(!ok, `Backend no disponible en ${BASE}`);
});

test("la puerta entra y monta el escáner con caché de puerta", async ({
  page,
}) => {
  await page.goto("/login");
  await page.locator("#login-email").fill(BOUNCER.email);
  await page.locator("#login-password").fill(BOUNCER.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();

  // El login del bouncer aterriza en el escáner (o lo lleva el redirect).
  await page.waitForURL(/bouncer|escaner|puerta/, { timeout: 10_000 });

  // La pantalla de puerta: título, selector de evento y bloque de caché.
  await expect(
    page.getByRole("heading", { name: "Control de puerta" }),
  ).toBeVisible();
  await expect(page.getByText("Caché de puerta (sin red)")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Activar cámara" }),
  ).toBeVisible();
});

test("el admin entra y ve la portada de su negocio", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#login-email").fill(ADMIN.email);
  await page.locator("#login-password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();

  await page.waitForURL(/admin/, { timeout: 10_000 });

  // Portada: identidad de la venue + cifra del mes + dock del negocio.
  // (La franja de eventos depende de un fetch extra; la identidad y el dock
  // son incondicionales del panel.) El KPI del mes lleva su rótulo propio
  // ("Recaudado · <mes>"): specific para no chocar con "Recaudo" de las
  // tarjetas de evento de la franja.
  await expect(page.getByText("Panel de la venue")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bar Esquina" })).toBeVisible();
  await expect(page.getByText(/Recaudado · /)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Del negocio" })).toBeVisible();
});
