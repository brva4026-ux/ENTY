/**
 * Regresión del gate legal: aceptar NO puede dejar la pantalla en negro.
 *
 * El bug: `LegalGate` llamaba `onCleared()` sin argumento y el handler de
 * `Layout` es un `setState`, así que guardaba `undefined`. El guard
 * `if (!legalCleared)` seguía abierto, `LegalGate` re-renderizaba con
 * `pending=[]` y devolvía `null`: la app entera en negro justo después de
 * dar las aceptaciones. Este spec exige que tras aceptar se vea el panel.
 *
 * Requiere el seed demo (`admin@bar.test` / `demo1234`) y que la cuenta tenga
 * documentos pendientes (el seed no crea aceptaciones: con las migraciones
 * legales aplicadas, siempre los tiene).
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";
// Cuenta dedicada del seed: es la unica que NO queda pre-aceptada, justo para
// que este spec siempre tenga documentos pendientes. Las demas cuentas demo
// (admin@bar.test, etc.) se siembran ya aceptadas para no romper el resto de
// la suite, que no sabe manejar el gate.
const ADMIN = { email: "gate@bar.test", password: "demo1234" };

async function backendDisponible() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ request }) => {
  const ok = await backendDisponible();
  test.skip(!ok, `Backend no disponible en ${BASE}`);
});

test("aceptar los documentos no deja la pantalla en negro", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/login");
  await page.locator("#login-email").fill(ADMIN.email);
  await page.locator("#login-password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();

  // El gate aparece bloqueando el panel cuando hay documentos pendientes. En
  // CI solo se aplica db/schema.sql (sin las filas de migraciones legales), así
  // que la tabla legal_documents va vacía y no hay nada que aceptar: se salta
  // en vez de fallar en rojo (misma convención que el resto de los specs).
  const gate = page.getByRole("heading", {
    name: "Hay cambios en los términos",
  });
  const panel = page.locator(".evx-card").first();
  await Promise.race([
    gate.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {}),
    panel.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {}),
  ]);
  test.skip(
    !(await gate.isVisible()),
    "la cuenta demo no tiene documentos legales pendientes",
  );

  // Se marca cada pendiente (el botón solo se habilita con todos marcados).
  const cajas = page.locator('input[type="checkbox"]');
  const n = await cajas.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) await cajas.nth(i).check();

  const aceptar = page.getByRole("button", { name: "Acepto y continúo" });
  await expect(aceptar).toBeEnabled();
  await aceptar.click();

  // El corazón del bug: tras aceptar tiene que verse el panel, no negro.
  await expect(
    page.getByRole("heading", { name: "Hay cambios en los términos" }),
  ).toHaveCount(0, { timeout: 10_000 });

  // #root con contenido visible = no es la pantalla negra. La franja de
  // eventos del admin llega con un fetch extra: se espera su primera tarjeta.
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.locator(".evx-card").first()).toBeVisible({
    timeout: 10_000,
  });

  expect(errors, `errores de página: ${errors.join(" | ")}`).toEqual([]);
});
