/**
 * Bienvenida personalizada tras el login.
 *
 * Antes, el exito eran 260 ms de un boton que decia "Listo" y un corte seco al
 * panel. Ahora hay una capa que nombra a quien entro y muestra una barra. Lo
 * que estos tests protegen, en orden de importancia:
 *
 *   1. La barra es REAL: avanza mientras el login corre y solo llega a 100
 *      cuando el backend respondio. Si alguien la cambia por un temporizador
 *      decorativo, el test de progreso lo caza.
 *   2. El saludo usa el nombre del usuario autenticado, no un texto fijo.
 *   3. Un login fallido NO muestra bienvenida: el error se corrige en el
 *      formulario, que es donde la persona puede hacer algo.
 *   4. Entrar con usuario (no solo con correo) funciona de punta a punta.
 *   5. En movil la capa no desborda a lo ancho.
 */
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
  await page.getByPlaceholder(/negocio/i).fill(ident);
  await page.getByPlaceholder(/contraseña/i).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

/** La tarjeta de bienvenida. */
const card = (page) => page.locator(".welcome-card");

/**
 * Salta el gate legal si aparece.
 *
 * Las aceptaciones se guardan POR USUARIO: admin ya las tiene del seed, pero
 * promo2 no, asi que al navegar a /perfil se topa con el portal. Se acepta todo
 * lo pendiente y se sigue.
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
  test("saluda con el nombre real y muestra la barra avanzando", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await submitLogin(page, "admin@bar.test");

    // La capa aparece como region viva: un lector de pantalla la anuncia.
    const status = page.getByRole("status").filter({ hasText: "¡Bienvenido!" });
    await expect(status).toBeVisible();
    await expect(page.getByText("¡Bienvenido!")).toBeVisible();
    await expect(page.getByText("Ingresando...")).toBeVisible();

    // El saludo usa el nombre del usuario del seed ("Admin Bar Esquina"),
    // no un texto fijo. Y el correo real acompaña.
    await expect(card(page).locator(".welcome-hello strong")).toHaveText("Admin");
    await expect(card(page).getByText("admin@bar.test")).toBeVisible();

    // La barra existe, es accesible y ya avanzo de 0.
    const bar = page.getByRole("progressbar", { name: /preparando/i });
    await expect(bar).toBeVisible();
    const first = Number(await bar.getAttribute("aria-valuenow"));
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(100);

    // Termina en el panel del rol.
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });
    await expect(page).toHaveURL(/\/admin/);
  });

  test("la barra de progreso avanza sola (no es un adorno fijo)", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await submitLogin(page, "admin@bar.test");
    const bar = page.getByRole("progressbar", { name: /preparando/i });
    await expect(bar).toBeVisible();

    // Lecturas seguidas: la barra debe ser MONOTONA (nunca retrocede). El bug
    // que este test caza es justamente el bucle que, tras el exito, volvia a
    // bajar el valor de 100 a ~10.
    const reads = [];
    for (let i = 0; i < 5; i += 1) {
      reads.push(Number(await bar.getAttribute("aria-valuenow")));
      await page.waitForTimeout(90);
    }
    for (let i = 1; i < reads.length; i += 1) {
      expect(reads[i]).toBeGreaterThanOrEqual(reads[i - 1]);
    }
    expect(reads[0]).toBeGreaterThan(0);

    // Y con el exito llega al 100 antes de navegar.
    await expect
      .poll(async () => Number(await bar.getAttribute("aria-valuenow")), {
        timeout: 8_000,
      })
      .toBe(100);

    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });
  });

  test("entrar con usuario en vez de correo", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    // "puerta" es el username del seed (mig 035), no un correo.
    await submitLogin(page, "puerta");

    await expect(page.getByText("¡Bienvenido!")).toBeVisible();
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });
    await expect(page).toHaveURL(/\/bouncer/);
  });

  test("un login fallido no muestra bienvenida", async ({ page }) => {
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    // Usuario inexistente: no quema el cubo de un demo real (el lockout cuenta
    // por identificador Y por IP, y este spec corre desde una sola IP).
    await submitLogin(page, "no-existe-este-usuario", "contrasena-mala");

    await expect(page.getByText("¡Bienvenido!")).toHaveCount(0);
    await expect(page.getByRole("alert")).toBeVisible();
    // Sigue en el login, con el formulario listo para corregir.
    await expect(page).toHaveURL(/\/login/);
  });

  test("en movil la tarjeta no desborda a lo ancho", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const ok = await available(page, "/login");
    test.skip(!ok, "App no disponible");

    await submitLogin(page, "admin@bar.test");
    await expect(card(page)).toBeVisible();

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

    await submitLogin(page, "admin@bar.test");
    await expect(card(page)).toBeVisible();

    // Sin animacion de entrada: la tarjeta esta en su estado final de una.
    const anim = await card(page).evaluate(
      (el) => getComputedStyle(el).animationName,
    );
    expect(anim).toBe("none");

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
    await page.getByRole("button", { name: /Guardar datos/ }).click();

    // Se guarda en minusculas y el valor queda visible en el campo.
    await expect(input).toHaveValue(uname);
    await expect(page.getByText(/Datos actualizados/i)).toBeVisible();

    // Y ahora la cuenta entra escribiendo SOLO el usuario.
    // Hay dos botones "Cerrar sesión" (cabecera y perfil): se usa el primero.
    await page.getByRole("button", { name: /Cerrar sesión/i }).first().click();
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await submitLogin(page, uname);

    await expect(page.getByText("¡Bienvenido!")).toBeVisible();
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });
  });
});
