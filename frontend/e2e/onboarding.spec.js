/**
 * La guia de primeros pasos: opt-in, re-apertura, tutorial guiado y
 * supervivencia al primer evento.
 *
 * Regresiones cubiertas aqui, en orden de aparicion:
 *
 * 1. `EventCreateModal` escribia `tf_onboarding_done` al crear el evento, asi
 *    que la guia se apagaba en el paso 1 de 4.
 * 2. La decision vivia en localStorage (por NAVEGADOR). El mismo admin que la
 *    rechazaba en la laptop volvia a verla en el celular, y el dominio de
 *    preview de Vercel no veia la decision de produccion. Ahora vive en el
 *    servidor (`/auth/me/preferences`), por usuario y negocio.
 * 3. La guia se renderizaba tambien dentro del backstage de un evento.
 * 4. El evento del onboarding era `events[0]` con la lista ordenada
 *    `starts_at DESC`: el evento de fecha MAS LEJANA. Publicar la fiesta de hoy
 *    y crear un borrador para el mes que viene reactivaba la guia.
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

test("la eleccion se guarda en el servidor, no en el navegador", async ({
  page,
}) => {
  await registrarNegocioNuevo(page);
  await page.getByTestId("onboarding-decline").click();
  await expect(page.getByTestId("onboarding-resume")).toBeVisible();

  // El bug de fondo: la decision vivia en localStorage (por navegador), asi
  // que otro dispositivo volvia a ofrecer la guia. Ahora vive en el servidor:
  // la API la devuelve y localStorage ya no guarda la decision.
  // La venue activa no siempre esta en localStorage (con un solo negocio el
  // panel cae a la primera disponible), asi que se pregunta a /auth/me.
  const prefs = await page.evaluate(async () => {
    const token = localStorage.getItem("tf_token");
    const headers = { Authorization: `Bearer ${token}` };
    const me = await (await fetch("/api/auth/me", { headers })).json();
    const venueId = Object.keys(me.roles || {})[0];
    const res = await fetch(`/api/auth/me/preferences?venue_id=${venueId}`, {
      headers,
    });
    return res.json();
  });
  const onboarding = prefs.preferences.find((p) => p.key === "onboarding");
  expect(onboarding.value).toBe("dismissed");

  // Y no queda rastro de la clave vieja: si quedara, otro navegador leeria de
  // ahi y el arreglo seria cosmetico.
  const claves = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("tf_onboarding"))
  );
  expect(claves).toEqual([]);
});

test("el tutorial recorre las anclas, guarda el avance y confirma la salida", async ({
  page,
}) => {
  await registrarNegocioNuevo(page);

  // "Si, mostrame" arranca el tutorial: recorte sobre la portada.
  await page.getByTestId("onboarding-accept").click();
  const tip = page.locator(".tour-tip");
  await expect(tip).toBeVisible({ timeout: 10_000 });
  await expect(tip).toContainText("Esta es tu portada");
  await expect(page.locator(".tour-hole")).toBeVisible();

  // Avanzar mueve el recorte al ancla siguiente.
  await page.getByTestId("tour-next").click();
  await expect(tip).toContainText("Tus eventos viven aquí");

  // Salir NO es un clic: primero pregunta, y "Continuar" cancela la salida.
  await page.getByTestId("tour-exit").click();
  await expect(page.getByTestId("tour-confirm-exit")).toBeVisible();
  await page.getByTestId("tour-stay").click();
  await expect(tip).toBeVisible();

  // Confirmar la salida lo cierra y deja la guia (la decision fue "accepted").
  await page.getByTestId("tour-exit").click();
  await page.getByTestId("tour-confirm-exit").click();
  await expect(tip).toBeHidden();

  // El avance quedo en el servidor: reabrirlo retoma donde estaba, no en el
  // paso 1.
  await page.getByTestId("onboarding-tour").click();
  await expect(tip).toContainText("Tus eventos viven aquí", { timeout: 10_000 });
});

test("el tutorial funciona en un negocio sin eventos (portada vacia)", async ({
  page,
}) => {
  await registrarNegocioNuevo(page);
  await page.getByTestId("onboarding-accept").click();
  const tip = page.locator(".tour-tip");
  await expect(tip).toBeVisible({ timeout: 10_000 });

  // Sin eventos, la portada muestra el estado vacio. El ancla "eventos" tiene
  // que existir IGUAL: si solo viviera en la lista con eventos, el tutorial
  // se saltaba justo los pasos que un negocio nuevo necesita.
  await page.getByTestId("tour-next").click();
  await expect(tip).toContainText("Tus eventos viven aquí");
  await expect(page.locator(".tour-hole")).toBeVisible();

  await page.getByTestId("tour-next").click();
  await expect(tip).toContainText("Crea tu primer evento");

  // El backstage no existe todavia: esos dos pasos se saltan solos y el
  // tutorial sigue con "Del negocio", sin quedar clavado senalando la nada.
  await page.getByTestId("tour-next").click();
  await expect(tip).toContainText("Del negocio, siempre a mano", {
    timeout: 10_000,
  });
});

test("crear el primer evento NO apaga la guia ni la mete en el backstage", async ({
  page,
}) => {
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

  // Dentro del backstage la guia no tiene nada que hacer: tapaba la pantalla
  // de trabajo del admin.
  await expect(page.getByText("Pon tu negocio a vender")).toBeHidden();
  await expect(page.getByTestId("onboarding-resume")).toBeHidden();

  // Volver a la lista: la guia SIGUE ahi, ahora en el paso 2 de 4.
  // Antes desaparecia aqui, con los pasos 2-4 sin mostrar.
  await page.goto("/admin");
  await expect(page.getByText("Pon tu negocio a vender")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("1/4")).toBeVisible();
  await expect(page.getByText("Definir tipos de boleta")).toBeVisible();
});
