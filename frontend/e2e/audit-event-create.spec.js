import { test, expect } from "@playwright/test";

/**
 * Regresión: el asistente "Nuevo evento" NO debe crear nada antes de que el
 * admin pulse "Crear evento" en el último paso.
 *
 * Bug encontrado en auditoría: el botón "Continuar" (pasos 1-2) y "Crear
 * evento" (paso 3) ocupaban el mismo nodo del árbol React (ambos <button>,
 * sin key). React reutilizaba el nodo y lo mutaba a type=submit; el navegador,
 * al resolver la acción por defecto del clic DESPUÉS de la mutación, enviaba
 * el formulario: el último "Continuar" creaba el evento solo, saltándose el
 * paso Aforo y guardando el cupo por defecto.
 */
test("el asistente de evento solo crea al pulsar Crear evento", async ({
  page,
  request,
}) => {
  await page.goto("/login");
  await page.locator("#login-email").fill("admin@bar.test");
  await page.locator("#login-password").fill("demo1234");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/admin/, { timeout: 15_000 });
  await page.waitForSelector(".evx-card, .evx-row", { timeout: 10_000 });

  const posts = [];
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      /\/events$/.test(new URL(r.url()).pathname)
    )
      posts.push(r.url());
  });

  await page.getByRole("button", { name: "Nuevo evento" }).first().click();
  const name = "E2E-AUDIT-" + Date.now();
  await page.locator('input[placeholder="Noche Electrónica"]').fill(name);

  // Paso 1 -> 2. No se puede crear todavía.
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Paso 2 de 3")).toBeVisible();
  expect(posts, "no crear al avanzar del paso 1").toHaveLength(0);

  // Paso 2 -> 3. Tampoco.
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Paso 3 de 3")).toBeVisible();
  expect(posts, "no crear al avanzar del paso 2").toHaveLength(0);

  // Único POST: al pulsar Crear evento, con el aforo elegido.
  await page.locator('input[placeholder="100"]').fill("120");
  await page.getByRole("button", { name: "Crear evento" }).click();
  await page.waitForURL(/\/admin\?event=/, { timeout: 15_000 });
  await expect
    .poll(() => posts.length, { timeout: 10_000 })
    .toBe(1);

  // El evento quedó con el aforo que el admin eligió, no con el default.
  const evId = new URL(page.url()).searchParams.get("event");
  const me = await (await page.request.get('/api/auth/me')).json();
  const venue = Object.keys(me.roles)[0];
  const res = await page.request.get(`/api/venues/${venue}/events`);
  expect(res.ok()).toBeTruthy();
  const ev = (await res.json()).find((e) => String(e.id) === evId);
  expect(ev, "el evento creado aparece en la lista del admin").toBeTruthy();
  expect(ev.name).toBe(name);
  expect(ev.capacity).toBe(120);
});
