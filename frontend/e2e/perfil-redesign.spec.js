/* global localStorage, document, window, fetch */
/**
 * E2E del rediseño de /perfil.
 *
 * Cubre lo que no se ve en una captura: la navegación por pestañas vive en la
 * URL, el contexto de la organización activa está siempre a la vista, los
 * cambios sin guardar no se pierden en silencio y las decisiones sensibles
 * (borrado, descarga) se piden al servidor antes de habilitar el botón.
 */
import { expect, test } from "@playwright/test";

const ADMIN = { email: "admin@bar.test", password: "demo1234" };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("tf_cookie_notice", "1.1");
    } catch {
      /* sin storage vuelve el aviso, pero no afecta a estas pruebas */
    }
  });
});

async function loginAdmin(page) {
  await page.goto("/login");
  await page.locator("#login-email").fill(ADMIN.email);
  await page.locator("#login-password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/admin/, { timeout: 15_000 });
}

test("escritorio: el perfil usa dos columnas y la organización activa está a la vista", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAdmin(page);
  await page.goto("/perfil");

  await expect(page.locator(".pf-shell")).toHaveCSS("display", "grid");
  await expect(page.locator(".pf-side")).toHaveCSS("position", "sticky");
  await expect(page.locator(".pf-main")).toBeVisible();

  const side = await page.locator(".pf-side").boundingBox();
  const main = await page.locator(".pf-main").boundingBox();
  expect(side && main && main.x > side.x + side.width - 1).toBeTruthy();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/\S+/);
  await expect(page.locator(".pf-hero-org-label")).toHaveText("Organización activa");
  await expect(page.locator(".pf-hero-org-wrap")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(5);
  await expect(page.getByRole("tab", { name: "Mi perfil" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("las pestañas se sincronizan con la URL y muestran su panel", async ({
  page,
}) => {
  await loginAdmin(page);

  await page.goto("/perfil?tab=seguridad");
  await expect(page.getByRole("heading", { name: "Seguridad de la cuenta" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Correo de acceso" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sesiones abiertas" })).toBeVisible();
  await expect(page.getByText("Este dispositivo", { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole("tab", { name: "Privacidad y datos" }).click();
  await expect(page).toHaveURL(/tab=privacidad/);
  await expect(
    page.getByRole("heading", { name: "Privacidad y datos" }),
  ).toBeVisible();

  // La elegibilidad la decide el servidor. La UI debe reflejar esa respuesta:
  // o el bloqueo, o la confirmación reforzada. Nunca un botón que falle luego.
  const check = await page.evaluate(async () => {
    const res = await fetch("/api/auth/account/deletion-check", {
      credentials: "include",
    });
    return res.json();
  });
  if (check.can_delete) {
    await page.getByRole("button", { name: "Eliminar mi cuenta…" }).click();
    await expect(page.locator("#del-pass")).toBeVisible();
    await expect(page.locator("#del-confirm")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Eliminar definitivamente" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Cancelar" }).click();
  } else {
    await expect(page.locator(".pf-deletion-blockers")).toBeVisible();
    await expect(page.getByText("El servidor encontró bloqueos")).toBeVisible();
  }

  await page.getByRole("button", { name: /Descargar mis datos \(JSON\)/ }).click();
  await expect(page.getByPlaceholder("Tu contraseña")).toBeVisible();
});

test("un cambio sin guardar abre el guardia y permite seguir o descartar", async ({
  page,
}) => {
  await loginAdmin(page);
  await page.goto("/perfil?tab=cuenta");

  const name = page.locator("#full-name");
  await expect(name).toBeVisible();
  await name.fill(`Nombre sin guardar ${Date.now()}`);

  await page.getByRole("tab", { name: "Seguridad" }).click();
  const dialog = page.getByRole("dialog", { name: "Tienes cambios sin guardar" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/perfil(\?|$)/);

  await page.getByRole("button", { name: "Seguir editando" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/perfil(\?|$)/);

  await page.getByRole("tab", { name: "Seguridad" }).click();
  await page.getByRole("button", { name: "Descartar y salir" }).click();
  await expect(page).toHaveURL(/tab=seguridad/);
  await expect(page.getByRole("heading", { name: "Seguridad de la cuenta" })).toBeVisible();
});

test("la organización que se edita se nombra y el contacto público es opt-in", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAdmin(page);
  await page.goto("/perfil?tab=negocio");

  await expect(page.getByRole("heading", { name: "Organización" })).toBeVisible();
  await expect(page.getByText("Editando esta organización")).toBeVisible();
  await expect(page.locator(".pf-editing strong")).toHaveText(/\S+/);
  await expect(page.locator(".pf-back")).toBeHidden();

  const publish = page.locator("#venue-public-contact");
  await expect(publish).not.toBeChecked();
  await publish.check();
  await expect(publish).toBeChecked();
  // Encender el canal no guarda ni publica por sí solo.
  await expect(
    page.getByRole("button", { name: "Guardar organización" }),
  ).toBeEnabled();
});

test("los avisos push solo se declaran activos con registro del servidor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // Un "1" en localStorage no acredita nada: el estado lo confirma el servidor.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("tf_push_enabled", "1");
      localStorage.setItem("push_registered", "1");
    } catch {
      /* sin storage no hay nada que fingir */
    }
  });
  await loginAdmin(page);
  await page.goto("/perfil?tab=preferencias");

  const box = page.locator(".pf-push-box");
  await expect(box).toBeVisible({ timeout: 10_000 });
  await expect(box).toHaveAttribute("data-state", "off");
  await expect(page.getByText("Avisos activos en este dispositivo")).toHaveCount(0);

  const status = await page.evaluate(async () => {
    const me = await fetch("/api/auth/me").then((r) => r.json());
    const venueId = me.active_venue_id ?? me.venues?.[0]?.id;
    return fetch(`/api/push/status?venue_id=${venueId}`).then((r) => r.json());
  });
  expect(status.registered).toBe(false);
  if (status.server_enabled) {
    await expect(box).toContainText(/Permiso|registro pendiente|Avisos a este dispositivo/);
  } else {
    await expect(box).toContainText("El servidor no tiene configurado");
  }
});

test("en móvil no hay scroll horizontal y las pestañas siguen accesibles", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAdmin(page);
  await page.goto("/perfil?tab=cuenta");

  await expect(page.getByRole("tab", { name: "Mi perfil" })).toBeVisible();
  await page.getByRole("tab", { name: "Preferencias" }).click();
  await expect(page).toHaveURL(/tab=preferencias/);
  await expect(page.getByRole("heading", { name: "Apariencia" })).toBeVisible();
  await expect(page.locator(".pf-back")).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(2);
});
