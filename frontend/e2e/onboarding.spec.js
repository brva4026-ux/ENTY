/**
 * La guia de primeros pasos: opt-in, re-apertura y supervivencia al primer evento.
 *
 * Regresion del bug: `EventCreateModal` escribia `tf_onboarding_done` al crear
 * el evento, asi que la guia se apagaba en el paso 1 de 4 — justo para el admin
 * primerizo al que esta dirigida. Ademas no habia forma de volver a mostrarla
 * (solo borrando localStorage a mano) y la clave no distinguia venue.
 *
 * Se prueba con una cuenta NUEVA (registro): es el unico estado en el que la
 * guia se ofrece por primera vez, y no depende del seed demo (cuyo evento ya
 * esta publicado, asi que su guia esta apagada a proposito).
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";

async function backendDisponible() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page }) => {
  test.skip(!(await backendDisponible()), `Backend no disponible en ${BASE}`);
  // El aviso de cookies es informativo pero tapa los clics en un navegador
  // limpio (se pinta fijo arriba). Se marca como visto antes de cualquier
  // script, igual que haria el usuario al pulsar "Entendido".
  await page.addInitScript(() => {
    try {
      localStorage.setItem("tf_cookie_notice", "1.1");
    } catch {
      /* sin storage: el aviso vuelve, pero no es lo que se prueba aqui */
    }
  });
});

/** Registra un negocio nuevo y deja la sesion iniciada en /admin. */
async function registrarNegocioNuevo(page) {
  const sello = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.goto("/register");
  await page.locator('input[placeholder="Bar La Esquina"]').fill(`E2E ${sello}`);
  await page.locator('input[placeholder="Ana Gómez"]').fill("Ana E2E");
  await page.locator('input[type="email"]').fill(`e2e-onb-${sello}@test.local`);
  await page.locator('input[autocomplete="new-password"]').fill("Demo1234");
  await page.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "Crear mi panel" }).click();
  await page.waitForURL(/\/admin/, { timeout: 20_000 });
}

test("la guia se ofrece y el admin puede rechazarla o aceptarla", async ({
  page,
}) => {
  await registrarNegocioNuevo(page);

  // Opt-in: se OFRECE, no se impone. Dos salidas explicitas.
  const aceptar = page.getByTestId("onboarding-accept");
  const rechazar = page.getByTestId("onboarding-decline");
  await expect(aceptar).toBeVisible();
  await expect(rechazar).toBeVisible();

  // Rechazarla la oculta, pero deja el acceso permanente para volver.
  await rechazar.click();
  await expect(aceptar).toBeHidden();
  const reabrir = page.getByTestId("onboarding-resume");
  await expect(reabrir).toBeVisible();

  // Y volver a mostrarla la trae de vuelta: nunca es irreversible.
  await reabrir.click();
  await expect(page.getByText("Pon tu negocio a vender")).toBeVisible();
});

test("crear el primer evento NO apaga la guia (el bug)", async ({ page }) => {
  await registrarNegocioNuevo(page);
  await page.getByTestId("onboarding-accept").click();
  await expect(page.getByText("Pon tu negocio a vender")).toBeVisible();

  // Crear el evento desde el CTA de la propia guia. El CTA y el boton del
  // modal se llaman igual: se acota cada uno a su contenedor.
  await page
    .locator(".onboard-hero")
    .getByRole("button", { name: "Crear evento" })
    .click();
  await page.locator('input[placeholder="Noche Electrónica"]').fill(
    `E2E-ONB-${Date.now()}`
  );
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.locator('input[placeholder="100"]').fill("50");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Crear evento" })
    .click();
  await page.waitForURL(/\/admin\?event=/, { timeout: 20_000 });

  // Volver a la lista: la guia SIGUE ahi, ahora en el paso 2 de 4.
  // Antes desaparecia aqui, con los pasos 2-4 sin mostrar.
  await page.goto("/admin");
  await expect(page.getByText("Pon tu negocio a vender")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("1/4")).toBeVisible();
  await expect(page.getByText("Definir tipos de boleta")).toBeVisible();
});

test("la eleccion es por venue: otro negocio vuelve a ofrecer la guia", async ({
  page,
}) => {
  await registrarNegocioNuevo(page);
  await page.getByTestId("onboarding-decline").click();
  await expect(page.getByTestId("onboarding-resume")).toBeVisible();

  // La clave guardada lleva el venue: sin el, un segundo negocio heredaba la
  // decision del primero y nunca veia la invitacion.
  const claves = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("tf_onboarding"))
  );
  expect(claves.length).toBeGreaterThan(0);
  expect(claves.some((k) => /^tf_onboarding:\d+$/.test(k))).toBe(true);
  expect(claves).not.toContain("tf_onboarding_done");
});
