/** Bienvenida por rol, autenticación y navegación al área de trabajo. */
import { expect, test } from "@playwright/test";

const DEMO_PASSWORD = "demo1234";

/** ¿La app está sirviendo? Si no, el test se salta (no falla). */
async function available(page, path) {
  return page
    .goto(path)
    .then((r) => !!r && r.status() < 500)
    .catch(() => false);
}

/** Rellena el formulario y pulsa Entrar, sin esperar la navegacion. */
async function submitLogin(page, ident, password = DEMO_PASSWORD) {
  await page.getByPlaceholder(/correo o @usuario/i).fill(ident);
  await page.getByPlaceholder(/contraseña/i).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

/** La tarjeta de bienvenida. */
const card = (page) => page.locator(".welcome-card");

/**
 * Salta el gate legal si aparece (defensivo).
 *
 * Las aceptaciones se guardan POR USUARIO y el seed ya pre-acepta a las cuentas
 * demo compartidas, asi que en condiciones normales el portal no sale. Se deja
 * igual por si una corrida contra una base sin re-sembrar lo deja pendiente: es
 * preferible aceptarlo y seguir que fallar por un estado de la DB ajeno al
 * spec.
 */
async function passLegalGate(page) {
  const gate = page.getByRole("heading", { name: "Hay cambios en los términos" });
  // El gate se monta un tick despues de la navegacion: preguntar de inmediato
  // daria "no hay gate" y el portal apareceria igual. Se espera a que la
  // pantalla se asiente: o sale el gate, o sale el panel.
  await Promise.race([
    gate.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {}),
    page
      .locator("#username")
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch(() => {}),
  ]);
  if (!(await gate.isVisible().catch(() => false))) return;
  const boxes = page.locator('input[type="checkbox"]');
  const n = await boxes.count();
  for (let i = 0; i < n; i += 1) await boxes.nth(i).check();
  await page.getByRole("button", { name: "Acepto y continúo" }).click();
  await expect(gate).toHaveCount(0, { timeout: 10_000 });
}

test.describe("bienvenida tras el login", () => {
  test("Administración entra con su nombre, acento y destino", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await submitLogin(page, "admin@bar.test");

    await expect(card(page)).toBeVisible({ timeout: 15_000 });
    await expect(card(page).getByRole("heading")).toHaveText(
      "Bienvenido a Administración",
    );
    await expect(page.locator(".welcome-scrim")).toHaveAttribute(
      "data-role-accent",
      "admin",
    );
    await expect(card(page).locator(".welcome-role-name")).toHaveText(
      "Administración",
    );

    await page.waitForURL(/\/admin/, { timeout: 15_000 });
  });

  test("Promotores entra a su espacio con acento ámbar", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await submitLogin(page, "promo1@bar.test");

    await expect(card(page)).toBeVisible({ timeout: 15_000 });
    await expect(card(page).getByRole("heading")).toHaveText(
      "Tu espacio de promotor",
    );
    await expect(page.locator(".welcome-scrim")).toHaveAttribute(
      "data-role-accent",
      "promotor",
    );

    await page.waitForURL(/\/promotor/, { timeout: 15_000 });
  });

  test("Puerta entra a su acceso con acento turquesa y aviso de asignación", async ({
    page,
  }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await submitLogin(page, "puerta");

    await expect(card(page)).toBeVisible({ timeout: 15_000 });
    await expect(card(page).getByRole("heading")).toHaveText("Tu acceso de Puerta");
    await expect(page.locator(".welcome-scrim")).toHaveAttribute(
      "data-role-accent",
      "bouncer",
    );
    await expect(card(page).locator(".welcome-role-note")).toContainText(
      "noche asignada",
    );

    await page.waitForURL(/\/bouncer/, { timeout: 15_000 });
  });

  test("con varios roles, elige uno y su acento cambia antes de entrar", async ({
    page,
  }) => {
    // La cuenta multi-rol se simula en la respuesta de login: el seed demo no
    // tiene una, y este test protege el selector de la bienvenida sin tocar
    // los roles reales de la base.
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: 999,
            full_name: "Multi Rol",
            email: "multi@example.test",
            username: "multirol",
            venues: [{ id: 1, name: "Sala Demo" }],
            roles: { 1: ["admin", "promotor", "bouncer"] },
          },
        }),
      }),
    );

    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await submitLogin(page, "multi@example.test");

    await expect(card(page)).toBeVisible({ timeout: 15_000 });
    await expect(card(page).getByRole("button", { name: "Puerta", exact: true })).toBeVisible();
    await expect(
      card(page).getByRole("button", { name: "Administración", exact: true }),
    ).toBeVisible();

    await card(page).getByRole("button", { name: "Puerta", exact: true }).click();
    await expect(card(page).getByRole("heading")).toHaveText("Tu acceso de Puerta");
    await expect(page.locator(".welcome-scrim")).toHaveAttribute(
      "data-role-accent",
      "bouncer",
    );

    await card(page).getByRole("button", { name: "Entrar a Puerta", exact: true }).click();
    await page.waitForURL(/\/bouncer/, { timeout: 15_000 });
  });

  test("en móvil, al enfocar el campo la portada se retira y Entrar sigue a la vista", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    const showcase = page.locator(".login-showcase");
    // El autofoco de escritorio puede haber retirado la portada ya; se
    // devuelve el foco al documento para medir el estado inicial.
    await page.evaluate(() => document.activeElement?.blur());
    await expect(showcase).toBeVisible();

    await page.locator("#login-email").focus();
    await expect(showcase).toBeHidden();

    const submit = page.getByRole("button", { name: "Entrar", exact: true });
    const box = await submit.boundingBox();
    expect(box).not.toBeNull();
    expect(box.y + box.height).toBeLessThanOrEqual(740);
  });

  test("con red lenta el botón muestra que está entrando y no pierde el formulario", async ({
    page,
  }) => {
    await page.route("**/api/auth/login", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await submitLogin(page, "admin@bar.test");
    await expect(
      page.getByRole("button", { name: /Entrando/ }),
    ).toBeVisible();
    await expect(page.locator("#login-email")).toBeVisible();

    await expect(page.getByText("Sesión verificada")).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(/\/admin/, { timeout: 15_000 });
  });

  test("saluda con el nombre real y explica las tareas del rol", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await submitLogin(page, "admin@bar.test");
    await expect(card(page).getByText("Sesión verificada")).toBeVisible();
    await expect(card(page).locator(".welcome-hello strong")).toHaveText("Admin");
    await expect(card(page).getByText("admin@bar.test")).toBeVisible();
    await expect(card(page).getByText("Crea y publica eventos")).toBeVisible();
    await expect(card(page).getByText("Configura boletas, precios y cupos")).toBeVisible();
    await expect(card(page).getByText("Consulta ventas y aforo en vivo")).toBeVisible();
    await card(page).getByRole("button", { name: "Entrar a Administración" }).click();
    await expect(page).toHaveURL(/\/admin/);
  });

  test("entrar con usuario en vez de correo", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    // "puerta" es el username del seed (mig 035), no un correo.
    await submitLogin(page, "puerta");

    await expect(page.getByText("Sesión verificada")).toBeVisible({ timeout: 15_000 });
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });
    await expect(page).toHaveURL(/\/bouncer/);
  });

  test("un login fallido no muestra bienvenida", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    // Usuario inexistente: no quema el cubo de un demo real (el lockout cuenta
    // por identificador Y por IP, y este spec corre desde una sola IP).
    await submitLogin(page, "no-existe-este-usuario", "contrasena-mala");

    await expect(page.getByText("Sesión verificada")).toHaveCount(0);
    await expect(page.getByRole("alert")).toBeVisible();
    // Sigue en el login, con el formulario listo para corregir.
    await expect(page).toHaveURL(/\/login/);
  });

  test("en movil la tarjeta no desborda a lo ancho", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await submitLogin(page, "admin@bar.test");
    await expect(card(page)).toBeVisible({ timeout: 15_000 });

    // Sin scroll horizontal: la tarjeta respeta los margenes laterales.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });
  });

  test("con movimiento reducido la bienvenida no anima", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    const ok = await available(page, "/login");
    if (!ok) {
      await context.close();
      test.skip(true, "App no disponible");
    }

    // Observa el estilo desde el primer render de la bienvenida.
    const animName = page.waitForFunction(
      () => {
        const el = document.querySelector(".welcome-card");
        return el ? getComputedStyle(el).animationName : false;
      },
      null,
      { timeout: 15_000, polling: "raf" },
    );

    await submitLogin(page, "admin@bar.test");

    // Sin animacion de entrada: la tarjeta esta en su estado final de una.
    expect(await (await animName).jsonValue()).toBe("none");

    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });
    await context.close();
  });
});

/**
 * El campo "Usuario" del perfil es la unica via para DEFINIR un usuario, y sin
 * un test del ciclo completo (guardar -> entrar con el) el campo podria quedar
 * guardando en un lugar y leyendo de otro sin que nadie lo note. Se usa un
 * usuario derivado de la hora para no chocar con el indice unico global.
 */
test.describe("ciclo del usuario en el perfil", () => {
  test("guarda el usuario y luego se entra con el", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    // Cuenta de trabajo: promo2, para no tocar los datos del admin.
    await submitLogin(page, "promo2@bar.test");
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });

    await page.goto("/perfil");
    await passLegalGate(page);
    const input = page.locator("#username");
    await expect(input).toBeVisible();

    const uname = `e2e${Date.now().toString().slice(-8)}`;
    await input.fill(uname);
    await page.getByRole("button", { name: /Guardar cambios/ }).click();

    // Se guarda en minusculas y el valor queda visible en el campo.
    await expect(input).toHaveValue(uname);
    await expect(page.getByText(/Guardado confirmado por el servidor/i)).toBeVisible();

    // Y ahora la cuenta entra escribiendo SOLO el usuario.
    // Hay dos botones "Cerrar sesión" (cabecera y perfil): se usa el primero.
    await page.getByRole("button", { name: /Cerrar sesión/i }).first().click();
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await submitLogin(page, uname);

    await expect(page.getByText("Sesión verificada")).toBeVisible({ timeout: 15_000 });
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });
  });
});

/**
 * "Recordarme" decide la VIDA de la cookie de sesion: marcado (default) lleva
 * max_age y sobrevive al cierre del navegador; sin marcar es una cookie de
 * sesion y muere con la pestaña. El token NUNCA vive en localStorage (la
 * sesion es HttpOnly), asi que lo que se protege es la expiracion, no el
 * almacen.
 */
test.describe("Recordarme elige la vida de la cookie de sesion", () => {
  test("sin marcar, la cookie es de sesion (no persiste)", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await page.locator("#remember-me").uncheck();
    await submitLogin(page, "promo2@bar.test");
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });

    const session = (await page.context().cookies()).find((c) => c.name === "tf_session");
    expect(session).toBeTruthy();
    // Playwright marca las cookies de sesion con expires === -1.
    expect(session.expires).toBe(-1);
    expect(await page.evaluate(() => localStorage.getItem("tf_token"))).toBeNull();
  });

  test("marcado, la cookie persiste (lleva expiracion)", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await page.locator("#remember-me").check();
    await submitLogin(page, "promo2@bar.test");
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });

    const session = (await page.context().cookies()).find((c) => c.name === "tf_session");
    expect(session).toBeTruthy();
    expect(session.expires).toBeGreaterThan(0);
  });

  test("sin marcar, tampoco recuerda el correo en el campo", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    const field = page.locator("#login-email");
    await field.fill("promo2@bar.test");
    // Con "Recordarme" marcado (default), el correo queda guardado.
    await page.reload();
    await expect(page.locator("#login-email")).toHaveValue("promo2@bar.test");

    // Al desmarcarlo, el correo se borra y no se vuelve a precargar: en un
    // dispositivo compartido el campo no debe delatar a la persona anterior.
    await page.locator("#remember-me").uncheck();
    await page.reload();
    await expect(page.locator("#login-email")).toHaveValue("");
    const leftover = await page.evaluate(() =>
      localStorage.getItem("enty_last_email"),
    );
    expect(leftover).toBeNull();
  });
});

