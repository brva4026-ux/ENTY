/**
 * Guardarraíl de accesibilidad del design system V-Pass (Fase 0 del plan
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
    // `alt=""` es un alt VÁLIDO (imagen decorativa): la regla exige el
    // ATRIBUTO, no un valor no vacío. Se usa hasAttribute para no marcar como
    // fallo un logo decorativo correctamente anotado.
    if (el.tagName === "IMG" && !el.hasAttribute("alt")) noAlt++;
  });
  return { contrastFails, tapSmall, noAlt };
}

async function audit(page) {
  await page.waitForTimeout(700);
  return page.evaluate(auditInPage);
}

const PUBLIC = [
  "/inicio",
  "/boletas",
  "/login",
  "/waitlist",
  "/register",
  "/reset",
  "/terminos",
  "/privacidad",
];

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

test("contraste AA y alt en el interior (admin, promotor, perfil)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/login");
  test.skip(!ok, "App no disponible");

  const fails = [];
  // /perfil entra aqui: el hero, los chips de rol y la zona de peligro estrenan
  // tintes propios, y una superficie con fondo propio es justo donde el
  // contraste se rompe sin que nadie lo note.
  for (const [email, path] of [
    ["admin@bar.test", "/admin"],
    ["promo1@bar.test", "/promotor"],
    ["admin@bar.test", "/perfil"],
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

test("el foco de teclado es visible y de un solo color (ambos temas)", async ({
  browser,
}) => {
  const ok = await available(await browser.newPage(), "/login");
  test.skip(!ok, "App no disponible");

  for (const scheme of ["dark", "light"]) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: scheme,
    });
    const page = await ctx.newPage();
    await page.goto("/login");

    const rings = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      // El `transition` de Tailwind incluye outline-color: se espera a que
      // asiente para no leer un color a medio animar.
      await page.waitForTimeout(220);
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return {
          outlineStyle: cs.outlineStyle,
          outlineWidth: parseFloat(cs.outlineWidth),
          outlineColor: cs.outlineColor,
        };
      });
      if (info && info.outlineStyle !== "none" && info.outlineWidth >= 2) {
        rings.push(info);
      }
    }
    await ctx.close();

    expect(
      rings.length,
      `[${scheme}] ningún control mostró anillo de foco al tabular`
    ).toBeGreaterThan(0);
    const colors = [...new Set(rings.map((r) => r.outlineColor))];
    expect(
      colors.length,
      `[${scheme}] anillos de distinto color: ${colors.join(", ")}`
    ).toBe(1);
  }
});

/**
 * Estructura de documento: cada pantalla tiene UN h1 y no salta niveles.
 * Hallazgo de la auditoria (oct-2026): /inicio, /waitlist, /promotor y /perfil
 * no tenian h1 (la jerarquia empezaba en h2/h3). Un h1 ausente deja al lector
 * de pantalla sin ancla de pagina. Este test lo fija.
 *
 * Ademas: cero scroll horizontal a 320px (el ancho mas chico real), que es el
 * mismo criterio que ya se exige para la vitrina.
 */
function headingReport() {
  const hs = [
    ...document.querySelectorAll("h1,h2,h3,h4,h5,h6"),
  ].filter((h) => {
    const cs = getComputedStyle(h);
    return cs.display !== "none" && cs.visibility !== "hidden";
  });
  const levels = hs.map((h) => Number(h.tagName[1]));
  let skip = null;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) {
      skip = `h${levels[i - 1]} -> h${levels[i]}`;
      break;
    }
  }
  const de = document.documentElement;
  return {
    h1: levels.filter((l) => l === 1).length,
    skip,
    overflow: de.scrollWidth > de.clientWidth + 1,
  };
}

test("estructura: un h1 por pantalla, sin saltos de nivel, sin scroll a 320px", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 800 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/inicio");
  test.skip(!ok, "App no disponible");

  const eventPath = await firstEventPath(page);
  const publicPaths = [
    "/inicio",
    "/boletas",
    "/login",
    "/register",
    "/reset",
    "/waitlist",
    "/terminos",
    "/privacidad",
  ];
  if (eventPath) publicPaths.push(eventPath);

  const fails = [];
  const seenTitles = new Set();
  for (const path of publicPaths) {
    await available(page, path);
    await page.waitForTimeout(500);
    const r = await page.evaluate(headingReport);
    if (r.h1 !== 1) fails.push({ path, issue: `h1=${r.h1}` });
    if (r.skip) fails.push({ path, issue: `salto ${r.skip}` });
    if (r.overflow) fails.push({ path, issue: "scroll horizontal @320px" });
    // Titulo de documento propio de la ruta: sin esto todas comparten el
    // <title> estatico ("V-Pass — Boletería y Aforo") en pestanas y enlaces.
    const title = await page.title();
    seenTitles.add(title);
    if (!title.endsWith("· V-Pass")) fails.push({ path, issue: `title generico: ${title}` });
  }
  // Y no puede ser el MISMO titulo en todas (dos rutas = dos titulos distintos).
  if (seenTitles.size < 2) fails.push({ "": "publicas", issue: `todas comparten title: ${[...seenTitles][0]}` });

  // El interior tambien: una pantalla de rol sin h1 rompe el ancla del lector.
  // /perfil entra aqui: su h1 vive en el hero y los paneles cuelgan en h2/h3,
  // asi que un salto de nivel se detecta igual que en las pantallas de rol.
  for (const [email, path] of [
    ["admin@bar.test", "/admin"],
    ["promo1@bar.test", "/promotor"],
    ["puerta@bar.test", "/bouncer"],
    ["admin@bar.test", "/perfil"],
  ]) {
    await login(page, email);
    await page.goto(path);
    await page.waitForTimeout(700);
    const r = await page.evaluate(headingReport);
    if (r.h1 !== 1) fails.push({ path, issue: `h1=${r.h1}` });
    const title = await page.title();
    if (!title.endsWith("· V-Pass")) fails.push({ path, issue: `title generico: ${title}` });
  }

  await ctx.close();
  if (fails.length) console.log("Estructura de encabezados:", JSON.stringify(fails, null, 2));
  expect(fails, "pantallas sin h1 unico o con saltos de nivel").toEqual([]);
});


/**
 * El h1 de /inicio no puede depender de que haya cartelera.
 *
 * Hueco que dejo pasar un bug real (oct-2026): el h1 vivia DENTRO de la rama
 * del destacado, asi que con la cartelera vacia la pagina se quedaba sin
 * encabezado. El test de arriba no lo cazaba porque corre con el seed demo,
 * donde siempre hay un evento publicado; y produccion estaba justo en el
 * estado opuesto (cero eventos), con lo que el fallo solo se veia en vivo.
 *
 * Aqui se fuerzan los dos estados alcanzables por un fan con el mismo build:
 *   1. busqueda sin resultados (el estado vacio de la vista filtrada), y
 *   2. el estado de error de la carga (API caida), interceptando la respuesta.
 * En ambos, /inicio debe seguir teniendo exactamente un h1.
 */
test("estructura: /inicio conserva un h1 sin cartelera (vacio y error)", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/inicio");
  test.skip(!ok, "App no disponible");

  const fails = [];

  // 1. Estado vacio: una busqueda que no puede devolver nada.
  await page.goto("/inicio");
  await page.getByLabel("Buscar eventos").fill("zzzz-sin-resultados-zzzz");
  await page.waitForTimeout(1200);
  const vacio = await page.evaluate(headingReport);
  if (vacio.h1 !== 1) fails.push({ estado: "vacio", issue: `h1=${vacio.h1}` });
  if (vacio.skip) fails.push({ estado: "vacio", issue: `salto ${vacio.skip}` });

  // 2. Estado de error: la cartelera no carga. Se corta la respuesta de la API
  //    publica para forzar la rama de error del componente.
  await page.route("**/api/public/**", (route) => route.abort());
  await page.goto("/inicio");
  await page.waitForTimeout(1200);
  const err = await page.evaluate(headingReport);
  if (err.h1 !== 1) fails.push({ estado: "error", issue: `h1=${err.h1}` });
  if (err.skip) fails.push({ estado: "error", issue: `salto ${err.skip}` });

  await ctx.close();
  if (fails.length) console.log("h1 fuera de la cartelera:", JSON.stringify(fails, null, 2));
  expect(fails, "/inicio sin h1 unico cuando no hay cartelera").toEqual([]);
});

