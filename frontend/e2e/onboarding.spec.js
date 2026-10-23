/**
 * La guía de primeros pasos: opt-in, re-apertura desde el perfil y
 * supervivencia al primer evento.
 *
 * Regresiones cubiertas:
 *  - `EventCreateModal` escribía `tf_onboarding_done` al crear el evento, así
 *    que la guía se apagaba en el paso 1 de 4 — justo para el admin primerizo
 *    al que está dirigida.
 *  - La guía vivía DENTRO del flujo del panel (233px la invitación, 458px el
 *    checklist) y empujaba la portada y los eventos hacia abajo, además de
 *    duplicarse con un botón al final de la página. Ahora es un diálogo.
 *  - La clave no distinguía venue.
 *
 * Se prueba con una cuenta NUEVA (registro): es el único estado en el que la
 * guía se ofrece por primera vez, y no depende del seed demo (cuyo evento ya
 * está publicado, así que su guía está apagada a propósito).
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
  // script, igual que haría el usuario al pulsar "Entendido".
  await page.addInitScript(() => {
    try {
      localStorage.setItem("tf_cookie_notice", "1.1");
    } catch {
      /* sin storage: el aviso vuelve, pero no es lo que se prueba aquí */
    }
  });
});

/** Registra un negocio nuevo y deja la sesión iniciada en /admin. */
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

  // Opt-in: se OFRECE como diálogo, no se impone. Dos salidas explícitas.
  const guia = page.getByTestId("onboarding-guide");
  const aceptar = page.getByTestId("onboarding-accept");
  const rechazar = page.getByTestId("onboarding-decline");
  await expect(guia).toBeVisible();
  await expect(aceptar).toBeVisible();
  await expect(rechazar).toBeVisible();

  // Rechazarla la cierra y NO deja nada en el panel: ni tarjeta ni botón
  // acumulándose. El reingreso vive en el perfil.
  await rechazar.click();
  await expect(guia).toBeHidden();
  await expect(page.getByTestId("onboarding-resume")).toHaveCount(0);

  // Y desde el perfil se puede volver a pedir: nunca es irreversible.
  await page.goto("/perfil?tab=negocio");
  const pedir = page.getByTestId("profile-onboarding-open");
  await expect(pedir).toBeVisible();
  await pedir.click();
  await page.waitForURL(/\/admin\?guia=1/, { timeout: 20_000 });
  await expect(page.getByTestId("onboarding-guide")).toBeVisible();
  await expect(page.getByText("Pon tu negocio a vender")).toBeVisible();
});

test("crear el primer evento NO apaga la guia (el bug)", async ({ page }) => {
  await registrarNegocioNuevo(page);
  await page.getByTestId("onboarding-accept").click();
  await expect(page.getByText("Pon tu negocio a vender")).toBeVisible();
  await expect(page.getByText("0/4")).toBeVisible();

  // Crear el evento desde el CTA de la propia guía. El CTA y el botón del
  // modal se llaman igual: se acota cada uno a su contenedor.
  await page
    .getByTestId("onboarding-guide")
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

  // Volver a la lista: la guía ya no se impone (no se acumula sobre el
  // panel), pero NO se perdió: se vuelve a pedir desde el perfil y aparece
  // con el paso 1 hecho (antes desaparecía aquí, con los pasos 2-4 sin ver).
  await page.goto("/perfil?tab=negocio");
  await page.getByTestId("profile-onboarding-open").click();
  await expect(page.getByText("Pon tu negocio a vender")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("1/4")).toBeVisible();
  await expect(page.getByText("Definir tipos de boleta")).toBeVisible();
});

test("la guia no empuja el panel: es un dialogo, no una tarjeta", async ({
  page,
}) => {
  await registrarNegocioNuevo(page);
  await expect(page.getByTestId("onboarding-guide")).toBeVisible();

  // Las animaciones de entrada de `.reveal` mueven los hijos unos px mientras
  // corren: se espera a que terminen para medir geometría real.
  const asentado = () =>
    page.waitForFunction(
      () => document.getAnimations().every((a) => a.playState !== "running"),
      null,
      { timeout: 5_000 }
    );

  // El diálogo se pinta por portal y es `fixed`: fuera del flujo del panel.
  const overlay = await page
    .getByTestId("onboarding-guide")
    .evaluate((el) => ({
      padreEsBody: el.parentElement === document.body,
      posicion: getComputedStyle(el).position,
    }));
  expect(overlay.padreEsBody).toBe(true);
  expect(overlay.posicion).toBe("fixed");

  await asentado();
  const conGuia = (await page.locator(".venue-header").boundingBox()).y;
  await page.getByTestId("onboarding-decline").click();
  await expect(page.getByTestId("onboarding-guide")).toBeHidden();
  await asentado();
  const sinGuia = (await page.locator(".venue-header").boundingBox()).y;

  // La prueba de fuego: la portada del negocio NO se mueve por tener la guía
  // delante. Antes la guía vivía en el flujo y la empujaba 200-450px abajo.
  expect(Math.abs(conGuia - sinGuia)).toBeLessThanOrEqual(1);
});

test("la eleccion es por venue: otro negocio vuelve a ofrecer la guia", async ({
  page,
}) => {
  await registrarNegocioNuevo(page);
  await page.getByTestId("onboarding-decline").click();
  await expect(page.getByTestId("onboarding-guide")).toBeHidden();

  // La clave guardada lleva el venue: sin él, un segundo negocio heredaba la
  // decisión del primero y nunca veía la invitación.
  const claves = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("tf_onboarding"))
  );
  expect(claves.length).toBeGreaterThan(0);
  expect(claves.some((k) => /^tf_onboarding:\d+$/.test(k))).toBe(true);
  expect(claves).not.toContain("tf_onboarding_done");
});
