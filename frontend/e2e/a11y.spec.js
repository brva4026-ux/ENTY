/**
 * Guardarraíl de accesibilidad del design system Enty (Fase 0 del plan
 * estético). Corre contra el backend REAL con seed demo (E2E_BASE_URL), igual
 * que el resto de specs; si la app no responde, se salta solo.
 *
 * Qué protege (lo que AGENTS.md exige y hoy nadie verifica):
 *   1. Contraste de texto ≥ 4.5:1 (≥ 3:1 en texto grande) en las superficies
 *      públicas y del interior, en tema oscuro y claro.
 *   2. Objetivos táctiles ≥ 44px en la puerta (superficie crítica de uso).
 *   3. Imágenes con alt.
 *
 * El contraste se calcula sobre el color COMPUTADO real: se toma el primer
 * fondo opaco del ancestro; si ese fondo es un degradado, se aproxima por su
 * primera parada opaca (suficiente para detectar el texto invisible que este
 * spec debe cazar). Los fallos se imprimen para poder depurarlos.
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

/** Login de un usuario demo y espera a salir de /login. */
async function login(page, email) {
  await page.goto("/login");
  await page.getByPlaceholder(/negocio/i).fill(email);
  await page.getByPlaceholder(/contraseña/i).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 10_000 });
}

/**
 * Auditoría inyectada en la página. Devuelve los fallos de contraste, los
 * objetivos táctiles pequeños y las imágenes sin alt.
 */
function auditInPage() {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const la = lum(a);
    const lb = lum(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };
  const bgOf = (el) => {
    // Un degradado solo es superficie si CUBRE el elemento: los trucos de
    // subrayado usan `background-size: 100% 1px`, que no tapa a los ancestros.
    const covers = (cs, node) => {
      const bs = cs.backgroundSize;
      if (!bs || bs === "auto" || bs.includes("cover") || bs.includes("contain")) return true;
      const h = bs.split(/\s+/).pop();
      if (h.endsWith("px")) return parseFloat(h) >= node.getBoundingClientRect().height - 1;
      return true;
    };
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.85) return c;
      // Un fondo con background-clip:text es un RELLENO DE TEXTO (truco de
      // subrayado/degradado), no una superficie: no tapa a los ancestros.
      const clip = cs.webkitBackgroundClip || cs.backgroundClip;
      const bi = cs.backgroundImage;
      if (clip !== "text" && bi && bi !== "none" && covers(cs, n)) {
        const stops = bi.match(/rgba?\([^)]+\)/g);
        if (stops) {
          const first = parse(stops.find((s) => (parse(s)?.a ?? 1) > 0.85) || "");
          if (first) return first;
        }
      }
      n = n.parentElement;
    }
    return { r: 11, g: 11, b: 15, a: 1 };
  };
  const contrastFails = [];
  const tapSmall = [];
  let noAlt = 0;
  document.querySelectorAll("body *").forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    if (parseFloat(cs.opacity) < 0.5) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const own = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 1
    );
    if (own) {
      const fg = parse(cs.color);
      if (fg && fg.a > 0.5) {
        const size = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const large = size >= 24 || (size >= 18.66 && bold);
        const cr = ratio(fg, bgOf(el));
        if (cr < (large ? 3 : 4.5)) {
          contrastFails.push({
            text: (el.textContent || "").trim().slice(0, 40),
            ratio: +cr.toFixed(2),
            size: Math.round(size),
          });
        }
      }
    }
    if (el.matches("a,button,input,select,textarea,[role=button]")) {
      if (r.width < 44 || r.height < 44) {
        tapSmall.push({
          label: (el.getAttribute("aria-label") || el.textContent || el.tagName)
            .trim()
            .slice(0, 30),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
    }
    if (el.tagName === "IMG" && !el.getAttribute("alt")) noAlt++;
  });
  return { contrastFails, tapSmall, noAlt };
}

async function audit(page) {
  await page.waitForTimeout(700);
  return page.evaluate(auditInPage);
}

const PUBLIC = ["/inicio", "/boletas", "/login", "/waitlist"];

/** Ruta de detalle de un evento real del catálogo (los ids derivan con el
 *  seed: no se puede clavar un /evento/N). Devuelve null si no hay ninguno. */
async function firstEventPath(page) {
  await available(page, "/inicio");
  const href = await page
    .locator('a[href^="/evento/"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  return href;
}

for (const scheme of ["dark", "light"]) {
  test(`contraste AA en superficies públicas (${scheme})`, async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: scheme,
    });
    const page = await ctx.newPage();
    const ok = await available(page, PUBLIC[0]);
    test.skip(!ok, "App no disponible");

    const eventPath = await firstEventPath(page);
    const paths = eventPath ? [...PUBLIC, eventPath] : PUBLIC;
    const fails = [];
    for (const path of paths) {
      await available(page, path);
      const r = await audit(page);
      for (const f of r.contrastFails) fails.push({ path, ...f });
    }
    await ctx.close();
    if (fails.length) console.log("Fallos de contraste:", JSON.stringify(fails, null, 2));
    expect(fails, `${fails.length} textos por debajo de AA`).toEqual([]);
  });
}

test("contraste AA y alt en el interior (admin, promotor)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/login");
  test.skip(!ok, "App no disponible");

  const fails = [];
  for (const [email, path] of [
    ["admin@bar.test", "/admin"],
    ["promo1@bar.test", "/promotor"],
  ]) {
    await login(page, email);
    await page.goto(path);
    const r = await audit(page);
    for (const f of r.contrastFails) fails.push({ path, ...f });
    expect(r.noAlt, `imágenes sin alt en ${path}`).toBe(0);
  }
  await ctx.close();
  if (fails.length) console.log("Fallos de contraste (interior):", JSON.stringify(fails, null, 2));
  expect(fails).toEqual([]);
});

test("la puerta: contraste AA y objetivos táctiles ≥ 44px", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/login");
  test.skip(!ok, "App no disponible");

  await login(page, "puerta@bar.test");
  await page.goto("/bouncer");
  const r = await audit(page);
  await ctx.close();

  if (r.contrastFails.length) console.log("Contraste (puerta):", JSON.stringify(r.contrastFails, null, 2));
  expect(r.contrastFails, "texto por debajo de AA en la puerta").toEqual([]);
  // La puerta es crítica: todo control debe ser cómodo de pulsar a una mano.
  if (r.tapSmall.length) console.log("Objetivos pequeños (puerta):", JSON.stringify(r.tapSmall, null, 2));
  expect(r.tapSmall, "objetivos táctiles < 44px en la puerta").toEqual([]);
});
