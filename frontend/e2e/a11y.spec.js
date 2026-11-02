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
  const controlFails = [];
  const tapSmall = [];
  let noAlt = 0;

  // --- Contraste no textual (WCAG 1.4.11) ---
  // El límite de un control de formulario debe dar 3:1 contra el color que lo
  // rodea. El chequeo de texto de arriba NO lo cubre: un input sin texto
  // propio (todos) es invisible para él, y por eso el borde casi transparente
  // de .field pasó desapercibido. Se mide el límite tal como lo ve el ojo:
  // borde sobre el relleno, o relleno sobre el fondo, o el anillo de foco.
  const over = (fg, bg) => {
    if (!fg) return bg;
    if (fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
    return {
      r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
      g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
      b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
      a: 1,
    };
  };
  // Primer fondo opaco FUERA del control (no el suyo): es contra eso que el
  // límite tiene que contrastar.
  const outsideOf = (el) => {
    let n = el.parentElement;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.85) return c;
      n = n.parentElement;
    }
    return { r: 11, g: 11, b: 15, a: 1 };
  };
  document.querySelectorAll("input:not([type=hidden]),select,textarea").forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    if (parseFloat(cs.opacity) < 0.5) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;

    const bw = parseFloat(cs.borderTopWidth) || 0;
    const app = cs.appearance || cs.webkitAppearance;
    // Un control NATIVO (appearance != none) sin caja propia lo dibuja el
    // navegador: no hay color que medir y su contraste no es nuestro.
    if (app !== "none" && bw === 0) return;

    const out = outsideOf(el);
    const own = over(parse(cs.backgroundColor), out);
    const borderR = bw > 0 ? ratio(over(parse(cs.borderTopColor), own), out) : 0;
    const fillR = parse(cs.backgroundColor)?.a > 0.05 ? ratio(own, out) : 0;

    // Anillo (box-shadow) con spread > 0: es el indicador de foco.
    let ringR = 0;
    const bs = cs.boxShadow;
    if (bs && bs !== "none") {
      for (const layer of bs.split(/,(?![^(]*\))/)) {
        const c = parse(layer);
        if (!c) continue;
        const spread = parseFloat((layer.match(/(-?[\d.]+)px(?=\s*$)/) || [])[1] || "0");
        if (spread <= 0) continue;
        ringR = Math.max(ringR, ratio(over(c, out), out));
      }
    }

    const best = Math.max(borderR, ringR, fillR);
    if (best < 3) {
      controlFails.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        cls: (el.className || "").toString().slice(0, 40),
        best: +best.toFixed(2),
        border: +borderR.toFixed(2),
        ring: +ringR.toFixed(2),
        fill: +fillR.toFixed(2),
      });
    }
  });

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
        // La opacidad del propio elemento (y de sus ancestros) aclara la tinta:
        // sin componerla, un texto con opacity 0.75 se medía con su color puro y
        // pasaba el guardarraíl aunque en pantalla quedara por debajo de AA (así
        // se escapó el pie legal del login en tema claro).
        let op = 1;
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          op *= parseFloat(getComputedStyle(n).opacity);
        }
        const bg = bgOf(el);
        const ink =
          op >= 1
            ? fg
            : {
                r: fg.r * op + bg.r * (1 - op),
                g: fg.g * op + bg.g * (1 - op),
                b: fg.b * op + bg.b * (1 - op),
                a: 1,
              };
        const cr = ratio(ink, bg);
        if (cr < (large ? 3 : 4.5)) {
          contrastFails.push({
            text: (el.textContent || "").trim().slice(0, 40),
            ratio: +cr.toFixed(2),
            size: Math.round(size),
            opacity: +op.toFixed(2),
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
  return { contrastFails, controlFails, tapSmall, noAlt };
}

async function audit(page) {
  await page.waitForTimeout(700);
  // La cascada de entrada anima opacidad: medir a mitad de frame compondría la
  // tinta contra una opacidad que en reposo no existe (falso positivo). Se
  // espera a que ninguna animación siga corriendo, con tope por si alguna fuese
  // infinita (entonces sí debe auditarse en su estado real).
  await page
    .waitForFunction(
      () => document.getAnimations().every((a) => a.playState !== "running"),
      null,
      { timeout: 3000 }
    )
    .catch(() => {});
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
    const controlFails = [];
    for (const path of paths) {
      await available(page, path);
      const r = await audit(page);
      for (const f of r.contrastFails) fails.push({ path, ...f });
      for (const f of r.controlFails) controlFails.push({ path, ...f });
    }
    await ctx.close();
    if (fails.length) console.log("Fallos de contraste:", JSON.stringify(fails, null, 2));
    if (controlFails.length)
      console.log("Fallos de contraste no textual:", JSON.stringify(controlFails, null, 2));
    expect(fails, `${fails.length} textos por debajo de AA`).toEqual([]);
    expect(controlFails, `${controlFails.length} controles con límite bajo 3:1`).toEqual([]);
  });
}

test("contraste AA y alt en el interior (admin, promotor, perfil)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/login");
  test.skip(!ok, "App no disponible");

  const fails = [];
  const controlFails = [];
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
    for (const f of r.controlFails) controlFails.push({ path, ...f });
    expect(r.noAlt, `imágenes sin alt en ${path}`).toBe(0);
  }
  await ctx.close();
  if (fails.length) console.log("Fallos de contraste (interior):", JSON.stringify(fails, null, 2));
  if (controlFails.length)
    console.log("Fallos de contraste no textual (interior):", JSON.stringify(controlFails, null, 2));
  expect(fails).toEqual([]);
  expect(controlFails).toEqual([]);
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
  if (r.controlFails.length)
    console.log("Contraste no textual (puerta):", JSON.stringify(r.controlFails, null, 2));
  expect(r.contrastFails, "texto por debajo de AA en la puerta").toEqual([]);
  expect(r.controlFails, "límite de control por debajo de 3:1 en la puerta").toEqual([]);
  // La puerta es crítica: todo control debe ser cómodo de pulsar a una mano.
  if (r.tapSmall.length) console.log("Objetivos pequeños (puerta):", JSON.stringify(r.tapSmall, null, 2));
  expect(r.tapSmall, "objetivos táctiles < 44px en la puerta").toEqual([]);
});

/**
 * El topbar del shell autenticado (marca, tema, notificaciones, avatar y
 * salir) no tenía cobertura táctil: la auditoría de 44px solo miraba la puerta,
 * así que cuatro controles de 30-39px pasaban desapercibidos. Aquí se mide solo
 * el topbar, y el área real incluye el ::after con el que los iconos crecen sin
 * cambiar su caja visible. Los enlaces de texto en línea (footer legal) quedan
 * fuera: la WCAG 2.5.8 los exime.
 */
test("el topbar autenticado: objetivos táctiles ≥ 44px", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/login");
  test.skip(!ok, "App no disponible");

  await login(page, "admin@bar.test");
  await page.goto("/admin");

  // El gate legal tapa el panel cuando hay documentos pendientes (CI aplica
  // solo schema.sql y no los tiene): se acepta si aparece, no se exige.
  const gate = page.getByRole("heading", { name: "Hay cambios en los términos" });
  await page.waitForTimeout(1_000);
  if (await gate.isVisible().catch(() => false)) {
    const cajas = page.locator('input[type="checkbox"]');
    for (let i = 0; i < (await cajas.count()); i++) await cajas.nth(i).check();
    await page.getByRole("button", { name: "Acepto y continúo" }).click();
    await expect(gate).toHaveCount(0, { timeout: 10_000 });
  }

  const small = await page.evaluate(() => {
    const out = [];
    const topbar = document.querySelector(".topbar");
    if (!topbar) return out;
    for (const el of topbar.querySelectorAll("a,button")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      let w = r.width;
      let h = r.height;
      const af = getComputedStyle(el, "::after");
      if (af.content && af.content !== "none" && af.position === "absolute") {
        w -= (parseFloat(af.left) || 0) + (parseFloat(af.right) || 0);
        h -= (parseFloat(af.top) || 0) + (parseFloat(af.bottom) || 0);
      }
      if (w < 44 || h < 44)
        out.push({
          label: (el.getAttribute("aria-label") || el.textContent || el.tagName)
            .trim()
            .slice(0, 30),
          w: Math.round(w),
          h: Math.round(h),
        });
    }
    return out;
  });
  await ctx.close();

  if (small.length) console.log("Objetivos pequeños (topbar):", JSON.stringify(small, null, 2));
  expect(small, "objetivos táctiles < 44px en el topbar autenticado").toEqual([]);
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
    // <title> estatico ("Enty — Boletería y Aforo") en pestanas y enlaces.
    const title = await page.title();
    seenTitles.add(title);
    if (!title.endsWith("· Enty")) fails.push({ path, issue: `title generico: ${title}` });
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
    if (!title.endsWith("· Enty")) fails.push({ path, issue: `title generico: ${title}` });
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


test("el texto de la home no baja de 14px (legibilidad 45-58)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const page = await ctx.newPage();
  const ok = await available(page, "/inicio");
  test.skip(!ok, "App no disponible");
  await page.waitForTimeout(2_500);

  // Cuenta los nodos de texto visibles por debajo del piso tipográfico. El
  // público mayoritario de la entrada (45-58) leía la home como un muro de
  // letra diminuta: 63% del texto estaba bajo 14px antes del arreglo.
  const chicos = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const txt = (el.textContent || "").trim();
      if (!txt || el.children.length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const px = parseFloat(cs.fontSize);
      if (px < 14)
        out.push({ txt: txt.slice(0, 30), px, clase: (el.className || el.tagName).toString().slice(0, 40) });
    }
    return out;
  });
  await ctx.close();

  if (chicos.length) console.log("Texto bajo 14px en la home:", JSON.stringify(chicos, null, 2));
  expect(chicos, "texto de la home por debajo del piso de 14px").toEqual([]);
});

/**
 * Guardarraíl del hero de la vitrina (/inicio): el texto del destacado tiene
 * que seguir siendo legible CUANDO HAY FLYER.
 *
 * Por qué existe este spec aparte: el audit de contraste de arriba camina los
 * fondos de los ANCESTROS. El flyer del destacado no es un fondo CSS: es un
 * <img> posicionado absoluto dentro del hero. Para el audit, el ancestro opaco
 * del texto es el hero (negro de marca), así que daba por bueno un titular que
 * en la vida real queda encima de una foto. Con un flyer claro el eyebrow caía
 * a 1.7:1 (AA pide 4.5:1) y nadie lo veía porque el seed demo NO trae flyers.
 *
 * Este spec no adivina: pinta el hero con un flyer claro (peor caso), oculta el
 * texto, y muestrea el PÍXEL real que hay detrás de cada texto con el scrim
 * aplicado. Si el scrim deja de cubrir la zona del titular, esto falla.
 */
test("el texto del destacado es legible sobre un flyer claro", async ({ browser }) => {
  const ok = await available(await browser.newPage(), "/inicio");
  test.skip(!ok, "App no disponible");

  // Flyer CLARO: el peor caso realista para texto blanco sobre foto.
  const LIGHT_FLYER =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#f2f0ea"/></svg>',
    );

  for (const [name, viewport] of [
    ["móvil", { width: 390, height: 844 }],
    ["escritorio", { width: 1440, height: 900 }],
  ]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await page.route("**/api/public/events**", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      for (const ev of body.events || []) ev.flyer_url = LIGHT_FLYER;
      await route.fulfill({ response: res, json: body });
    });
    await page.goto("/inicio");
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
    await page.waitForTimeout(400);

    const hero = page.locator(".home-feature");
    if ((await hero.count()) === 0) {
      await ctx.close();
      test.skip(true, "sin destacado en el catálogo");
      return;
    }

    // Punto de muestreo por texto, ANTES de ocultarlo.
    const targets = await page.evaluate(() => {
      const out = {};
      for (const sel of [".home-eyebrow", ".home-feature-top h1, .home-feature-top h2", ".home-feature-meta"]) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out[sel] = {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height * 0.4),
          color: cs.color,
          size: parseFloat(cs.fontSize),
          weight: parseInt(cs.fontWeight, 10) || 400,
        };
      }
      return out;
    });

    // Ocultar el texto para leer el fondo puro (scrim + flyer) sin letras.
    await page.addStyleTag({ content: ".home-feature-body{visibility:hidden !important;}" });
    await page.waitForTimeout(150);

    const fails = [];
    for (const [sel, t] of Object.entries(targets)) {
      const shot = await page.screenshot({ clip: { x: t.x, y: t.y, width: 1, height: 1 } });
      const { bg, ratio } = await page.evaluate(
        async ({ dataUrl, color }) => {
          const parse = (c) => {
            const m = c.match(/rgba?\(([^)]+)\)/);
            const p = m[1].split(",").map(parseFloat);
            return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
          };
          const lum = ({ r, g, b }) => {
            const f = (v) => {
              v /= 255;
              return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
          };
          const img = new Image();
          img.src = dataUrl;
          await img.decode();
          const cv = document.createElement("canvas");
          cv.width = 1;
          cv.height = 1;
          const cx = cv.getContext("2d");
          cx.drawImage(img, 0, 0);
          const d = cx.getImageData(0, 0, 1, 1).data;
          const bg = { r: d[0], g: d[1], b: d[2] };
          const fg = parse(color);
          const la = lum(fg);
          const lb = lum(bg);
          const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
          return { bg, ratio };
        },
        { dataUrl: `data:image/png;base64,${shot.toString("base64")}`, color: t.color },
      );
      const large = t.size >= 24 || (t.size >= 18.66 && t.weight >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        fails.push({
          viewport: name,
          sel,
          ratio: +ratio.toFixed(2),
          need,
          fondo: `rgb(${bg.r},${bg.g},${bg.b})`,
        });
      }
    }
    await ctx.close();

    if (fails.length) console.log("Hero ilegible sobre flyer claro:", JSON.stringify(fails, null, 2));
    expect(fails, "texto del destacado por debajo de AA sobre un flyer claro").toEqual([]);
  }
});

/**
 * El <main> de la vitrina: /inicio debe tener UN landmark principal que
 * contenga el contenido (axe: landmark-one-main + region). Sin él, un lector
 * de pantalla no puede saltar al contenido ni ubicarse en la página.
 */
test("/inicio tiene un único landmark principal con el contenido", async ({ browser }) => {
  const ok = await available(await browser.newPage(), "/inicio");
  test.skip(!ok, "App no disponible");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto("/inicio");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const mains = [...document.querySelectorAll("main, [role=main]")];
    const first = mains[0];
    return {
      count: mains.length,
      tieneH1: !!first?.querySelector("h1"),
      tieneLista: !!first?.querySelector(".home-list, .home-grid, .home-empty"),
      // el contenido no puede quedar fuera del landmark
      sueltos: [...document.querySelectorAll(".home > .home-search, .home > .home-cats, .home > .home-ticker")].length,
    };
  });
  await ctx.close();
  expect(r.count, "landmarks principales en /inicio").toBe(1);
  expect(r.tieneH1, "el h1 debe vivir dentro del landmark principal").toBe(true);
  expect(r.tieneLista, "la cartelera debe vivir dentro del landmark principal").toBe(true);
  expect(r.sueltos, "contenido fuera del landmark principal").toBe(0);
});

/**
 * El panel de avisos de /inicio (la campana) es un `role="dialog"`: un diálogo
 * que no se cierra con Escape deja al usuario de teclado atrapado mirándolo (no
 * hay overlay que toque, y el botón de la campana ya está "detrás"). El patrón
 * dropdown del resto de la app (NotificationBell) cierra con Escape Y con clic
 * fuera; este panel solo cerraba con el botón de la campana o al elegir un
 * aviso. Se prueba lo que el usuario percibe: Escape cierra, y el foco vuelve a
 * la campana (no se queda en el body).
 */
test("el panel de avisos de /inicio se cierra con Escape y devuelve el foco", async ({ browser }) => {
  const ok = await available(await browser.newPage(), "/inicio");
  test.skip(!ok, "App no disponible");
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const page = await ctx.newPage();
  await page.goto("/inicio");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
  await page.waitForTimeout(300);

  const campana = page.getByRole("button", { name: "Notificaciones" });
  await campana.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  await expect(page.locator(".home-bell-panel"), "el panel abre con la campana").toHaveCount(1);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  await expect(page.locator(".home-bell-panel"), "Escape cierra el panel").toHaveCount(0);

  const foco = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  await ctx.close();
  expect(foco, "el foco vuelve a la campana tras cerrar").toBe("Notificaciones");
});

/**
 * El aviso de cookies vive fuera de <main> (es chrome global, en main.jsx). Con
 * role="note" no era un landmark: axe lo marcaba como `region` (contenido fuera
 * de todo landmark) en TODAS las páginas, incluida /inicio. Al ser `region`
 * con nombre, el aviso pasa a ser un landmark navegable: el usuario de lector
 * de pantalla puede saltar a él y ubicarlo en el mapa de la página.
 */
test("el aviso de cookies es un landmark navegable", async ({ browser }) => {
  const ok = await available(await browser.newPage(), "/inicio");
  test.skip(!ok, "App no disponible");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  // Primer render, sin descartar el aviso: es cuando un visitante nuevo lo ve.
  await page.goto("/inicio");
  await page.waitForTimeout(600);
  const aviso = page.getByRole("region", { name: "Aviso de cookies" });
  await expect(aviso, "el aviso se expone como landmark con nombre").toBeVisible();
  await ctx.close();
});

/**
 * /boletas tenía el mismo hueco que /inicio antes del fix: el título y el
 * buscador vivían fuera de todo landmark (axe: landmark-one-main + region). Es
 * la pantalla donde el fan recupera sus entradas, así que necesita el mismo
 * landmark principal que la vitrina. El <main> es semántica: la cascada de
 * entrada (.home-main > *) conserva el escalonado bloque a bloque.
 */
test("/boletas tiene un único landmark principal con el contenido", async ({ browser }) => {
  const ok = await available(await browser.newPage(), "/boletas");
  test.skip(!ok, "App no disponible");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto("/boletas");
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const mains = [...document.querySelectorAll("main, [role=main]")];
    const first = mains[0];
    return {
      count: mains.length,
      tieneH1: !!first?.querySelector("h1"),
      tieneBuscador: !!first?.querySelector(".fan-lookup"),
      // el buscador no puede quedar fuera del landmark
      sueltos: [...document.querySelectorAll(".home > .fan-lookup, .home > .home-title")].length,
    };
  });
  await ctx.close();
  expect(r.count, "landmarks principales en /boletas").toBe(1);
  expect(r.tieneH1, "el h1 debe vivir dentro del landmark principal").toBe(true);
  expect(r.tieneBuscador, "el buscador debe vivir dentro del landmark principal").toBe(true);
  expect(r.sueltos, "contenido fuera del landmark principal").toBe(0);
});

  /**
   * /waitlist y /reset quedaron sin landmark principal: todo su contenido
   * (título, formulario) vivía fuera de `<main>` (axe: landmark-one-main +
   * region). Son pantallas públicas a las que se llega sin contexto, así que la
   * región principal es lo que permite saltar el resto con un lector de pantalla.
   */
  for (const ruta of ["/waitlist", "/reset"]) {
    test(`${ruta} tiene un único landmark principal`, async ({ browser }) => {
      const ok = await available(await browser.newPage(), ruta);
      test.skip(!ok, "App no disponible");
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(ruta);
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const mains = [...document.querySelectorAll("main, [role=main]")];
        const first = mains[0];
        return {
          count: mains.length,
          tieneH1: !!first?.querySelector("h1"),
        };
      });
      await ctx.close();
      expect(r.count, `landmarks principales en ${ruta}`).toBe(1);
      expect(r.tieneH1, "el h1 debe vivir dentro del landmark principal").toBe(true);
    });
  }

  /**
   * El logo del header legal es un botón con texto visible ("Enty") y
   * `aria-label`: WCAG 2.5.3 exige que el nombre accesible contenga el texto
   * visible, si no, quien usa control por voz no puede activarlo diciendo
   * "Enty". Se comprueba en las tres páginas legales, que comparten header.
   */
  for (const ruta of ["/terminos", "/privacidad", "/cookies"]) {
    test(`${ruta}: el botón del logo incluye su texto visible en el nombre accesible`, async ({
      browser,
    }) => {
      const ok = await available(await browser.newPage(), ruta);
      test.skip(!ok, "App no disponible");
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(ruta);
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const btn = document.querySelector("header button[aria-label]");
        if (!btn) return null;
        return {
          label: btn.getAttribute("aria-label"),
          texto: (btn.textContent || "").trim(),
        };
      });
      await ctx.close();
      expect(r, `botón de logo en ${ruta}`).not.toBeNull();
      expect(
        r.label.toLowerCase().includes(r.texto.toLowerCase()),
        `el nombre accesible "${r.label}" debe contener el texto visible "${r.texto}"`
      ).toBe(true);
    });
  }

  /**
   * Las tablas del markdown legal son anchas y hacen scroll horizontal. Un
   * contenedor con scroll tiene que poder alcanzarse con el teclado (WCAG 2.1.1)
   * y, si su cabecera viene vacía en el markdown (`| | |`), no debe emitir
   * `<th>` sin texto (axe: empty-table-header). Dos regiones con el mismo nombre
   * accesible violan landmark-unique, así que se numeran.
   */
  test("las tablas legales son navegables y sin cabeceras vacías", async ({ browser }) => {
    const ok = await available(await browser.newPage(), "/privacidad");
    test.skip(!ok, "App no disponible");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto("/privacidad");
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const wraps = [...document.querySelectorAll(".legal-table-wrap")];
      const labels = wraps.map((w) => w.getAttribute("aria-label"));
      return {
        total: wraps.length,
        sinTabIndex: wraps.filter((w) => w.tabIndex < 0).length,
        thVacios: [...document.querySelectorAll(".legal-table th")].filter(
          (th) => !(th.textContent || "").trim()
        ).length,
        labelsUnicos: new Set(labels).size === labels.length,
      };
    });
    await ctx.close();
    expect(r.total, "tablas en /privacidad").toBeGreaterThan(0);
    expect(r.sinTabIndex, "tablas con scroll inalcanzables por teclado").toBe(0);
    expect(r.thVacios, "celdas de encabezado sin texto").toBe(0);
    expect(r.labelsUnicos, "nombres de región duplicados").toBe(true);
  });

  /**
   * /inicio: filtrar (buscar, categoría, fecha, ciudad) re-renderiza la rejilla
   * en silencio. Sin región viva, quien no ve la pantalla no sabe cuántos eventos
   * quedaron. Además el h1 decía "Sin resultados" en cuanto hubiera CUALQUIER
   * filtro puesto, aunque quedaran eventos: se anuncia un resultado que no es.
   * Ambas cosas se prueban con un filtro que SÍ deja resultados.
   */
  test("/inicio anuncia el resultado de filtrar y el h1 refleja la cartelera real", async ({
    browser,
  }) => {
    const ok = await available(await browser.newPage(), "/inicio");
    test.skip(!ok, "App no disponible");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto("/inicio");
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
    await page.waitForTimeout(300);

    const leer = () =>
      page.evaluate(() => ({
        h1: document.querySelector("h1")?.textContent.trim() ?? "",
        live: document.querySelector('[role=status][aria-live]')?.textContent.trim() ?? "",
        filas:
          document.querySelectorAll(".home-row").length +
          (document.querySelector(".home-feature") ? 1 : 0),
      }));

    const inicial = await leer();
    // La región viva existe en reposo (si se montara solo al escribir, el lector
    // no la reconocería como región) y ya describe la cartelera.
    expect(inicial.live, "anuncio inicial de la cartelera").toMatch(/evento/);

    // Filtro por categoría que deja al menos un evento (el seed trae música:
    // "Conciertos" deja 2). Con "narrowed" el h1 viejo decía "Sin resultados".
    await page.getByRole("button", { name: "Conciertos", exact: true }).click();
    await page.waitForTimeout(700);
    const conFiltro = await leer();

    expect(conFiltro.filas, "el filtro debe dejar eventos (si no, el test no prueba el bug)").toBeGreaterThan(0);
    expect(
      conFiltro.h1,
      "el h1 no debe decir 'Sin resultados' cuando sí hay eventos"
    ).not.toContain("Sin resultados");
    expect(conFiltro.live, "el anuncio debe contar los eventos que quedaron").toMatch(
      /\d+ eventos?/
    );

    // Filtro sin resultados: ahora sí debe avisarlo, en el h1 y en la región viva.
    await page.getByLabel("Buscar eventos").fill("zzzz-sin-resultados-zzzz");
    await page.waitForTimeout(700);
    const vacio = await leer();
    expect(vacio.filas, "no debe quedar ningún evento").toBe(0);
    expect(vacio.h1, "el h1 debe reflejar el vacío").toContain("Sin resultados");
    expect(vacio.live, "la región viva debe avisar que no hay resultados").toContain(
      "Sin resultados"
    );

    await ctx.close();
  });

/**
 * Vitrina de /inicio: la presentación de la primera pantalla.
 *
 * Auditoría de oct-2026: el primer scroll gastaba 421px en andamiaje (buscador
 * + 6 categorías + 4 fechas + banda) antes de que apareciera un solo evento, y
 * el titular de la página era `sr-only`, así que en pantalla no había ninguna
 * frase que dijera qué es esta página. Además:
 *   - "Próximos" quedaba colgando sobre un `.home-list` de 0px (con un único
 *     evento el hero ES toda la cartelera).
 *   - La banda cinética repetía las 5 categorías que están justo encima.
 *   - El anillo de aforo mostraba "1% VENDIDO" ocupando el sitio más visible.
 *   - Las categorías hacían scroll (677px en 350px) sin ninguna pista.
 *   - El buscador cortaba su propio placeholder en móvil.
 *
 * Cada test mide lo que el usuario percibe, no la implementación.
 */
/**
 * Sirve una cartelera fija para que las medidas de layout no dependan del seed
 * (que se re-ejecuta entre corridas y que otras specs modifican creando
 * eventos). `n` es cuántos eventos devuelve /public/events.
 */
async function sembrarCatalogo(page, n) {
  const base = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const events = Array.from({ length: n }, (_, i) => ({
    id: 900_000 + i,
    name: `Evento de prueba ${i + 1}`,
    starts_at: new Date(new Date(base).getTime() + i * 86_400_000).toISOString(),
    timezone: "America/Bogota",
    venue: "Bar Esquina",
    location: "Bogotá, Colombia",
    category: "Música",
    price_cents: 30000,
    sold_pct: 1,
    flyer_url: null,
  }));
  await page.route("**/api/public/events**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events }) })
  );
}

test.describe("vitrina /inicio: presentación de la primera pantalla", () => {
  test("el titular es visible y la primera pantalla muestra un evento", async ({ browser }) => {
    const ok = await available(await browser.newPage(), "/inicio");
    test.skip(!ok, "App no disponible");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    // Catálogo controlado: el seed cambia entre corridas (y otras specs crean
    // eventos), así que el layout se mide sobre una cartelera fija.
    await sembrarCatalogo(page, 1);
    await page.goto("/inicio");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      const hr = h1?.getBoundingClientRect();
      const feat = document.querySelector(".home-feature")?.getBoundingClientRect();
      return {
        texto: h1?.textContent.trim() ?? "",
        visible: !!hr && hr.width > 1 && hr.height > 1,
        // `sr-only` deja 1px: cualquier tamaño real prueba que se pinta.
        fs: h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0,
        heroTop: hr ? Math.round(hr.top) : -1,
        featureTop: feat ? Math.round(feat.top) : -1,
        vh: window.innerHeight,
      };
    });
    await ctx.close();

    expect(r.visible, "el h1 de la vitrina debe ser visible, no sr-only").toBe(true);
    expect(r.fs, "el titular debe leerse como titular, no como texto oculto").toBeGreaterThan(20);
    expect(r.texto.length, "el titular debe decir algo").toBeGreaterThan(0);
    // El titular va arriba: antes quedaba detrás de 421px de filtros.
    expect(r.heroTop, "el titular debe ir al principio del contenido").toBeLessThan(200);
    // Y debe quedar sitio para el contenido dentro del primer scroll.
    expect(
      r.featureTop,
      "el destacado debe empezar dentro del primer scroll"
    ).toBeLessThan(r.vh);
  });

  test("el buscador no corta su propio placeholder", async ({ browser }) => {
    const ok = await available(await browser.newPage(), "/inicio");
    test.skip(!ok, "App no disponible");
    // El ancho más estrecho razonable: si aquí cabe, cabe en cualquier teléfono.
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 } });
    const page = await ctx.newPage();
    await page.goto("/inicio");
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
    await page.waitForTimeout(300);

    const r = await page.evaluate(() => {
      const i = document.querySelector(".home-search input");
      if (!i) return null;
      const cs = getComputedStyle(i);
      const c = document.createElement("canvas").getContext("2d");
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const anchoTexto = c.measureText(i.placeholder).width;
      const disponible =
        i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 30;
      return { ph: i.placeholder, anchoTexto, disponible };
    });
    await ctx.close();

    expect(r, "el buscador debe existir").not.toBeNull();
    expect(
      r.anchoTexto,
      `el placeholder "${r.ph}" (${Math.round(r.anchoTexto)}px) no cabe en ${Math.round(r.disponible)}px`
    ).toBeLessThanOrEqual(r.disponible);
  });

  test("las categorías avisan de que hay más fuera de pantalla", async ({ browser }) => {
    const ok = await available(await browser.newPage(), "/inicio");
    test.skip(!ok, "App no disponible");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto("/inicio");
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
    await page.waitForTimeout(300);

    const r = await page.evaluate(() => {
      const el = document.querySelector(".home-cats");
      if (!el) return null;
      const cs = getComputedStyle(el);
      const mask = cs.maskImage || cs.webkitMaskImage || "";
      return {
        desborda: el.scrollWidth > el.clientWidth + 2,
        tienePista: mask && mask !== "none",
        marca: el.dataset.scrolled ?? "",
      };
    });
    await ctx.close();

    expect(r, "la banda de categorías debe existir").not.toBeNull();
    if (!r.desborda) return; // si todo cabe, no hace falta pista
    expect(r.tienePista, "una fila que desborda debe avisar de que hay más").toBe(true);
    expect(r.marca, "el estado de scroll debe estar marcado").not.toBe("");
  });

  test("el destacado prioriza la fecha y no muestra aforo irrelevante", async ({ browser }) => {
    const ok = await available(await browser.newPage(), "/inicio");
    test.skip(!ok, "App no disponible");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto("/inicio");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => {
      const when = document.querySelector(".home-feature-when");
      const ring = document.querySelector(".home-ring");
      const pct = ring?.querySelector("text")?.textContent.trim() ?? "";
      return {
        hayFecha: !!when,
        textoFecha: when?.textContent.trim() ?? "",
        fsFecha: when ? parseFloat(getComputedStyle(when.querySelector("b")).fontSize) : 0,
        hayAnillo: !!ring,
        pct,
      };
    });
    await ctx.close();

    expect(r.hayFecha, "el destacado debe mostrar la fecha en su propia línea").toBe(true);
    expect(r.textoFecha.length, "la fecha no puede ir vacía").toBeGreaterThan(0);
    expect(r.fsFecha, "la fecha debe leerse, no ser letra pequeña").toBeGreaterThanOrEqual(18);
    // El anillo solo se pinta cuando el aforo ya es una señal (>= 70%).
    if (r.hayAnillo) {
      const n = parseInt(r.pct, 10);
      expect(n, `el anillo no debe aparecer con aforo irrelevante (mostró ${r.pct})`).toBeGreaterThanOrEqual(70);
    }
  });

  test("'Próximos' no queda colgando cuando no hay lista", async ({ browser }) => {
    const ok = await available(await browser.newPage(), "/inicio");
    test.skip(!ok, "App no disponible");

    const medir = async (n) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      // El catálogo se fija a mano: con 1 evento no hay lista, con 2 sí. Depender
      // del seed hacía el test no determinista (otras specs añaden eventos).
      await sembrarCatalogo(page, n);
      await page.goto("/inicio");
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "Entendido" }).click().catch(() => {});
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const list = document.querySelector(".home-list");
        return {
          filas: document.querySelectorAll(".home-row").length,
          haySubhead: !!document.querySelector(".home-subhead"),
          altoLista: list ? Math.round(list.getBoundingClientRect().height) : -1,
        };
      });
      await ctx.close();
      return r;
    };

    // Con UN evento el hero ES toda la cartelera: no puede haber encabezado de
    // lista sobre un `.home-list` vacío.
    const solo = await medir(1);
    expect(solo.filas, "el caso base debe tener un único evento").toBe(0);
    expect(
      solo.haySubhead,
      `"Próximos" no debe renderizarse sin filas (lista de ${solo.altoLista}px)`
    ).toBe(false);

    // Con lista, el encabezado vuelve (el invariante corta en las dos direcciones).
    const varios = await medir(3);
    expect(varios.filas, "el segundo caso debe tener lista").toBeGreaterThan(0);
    expect(varios.haySubhead, "con filas, el encabezado debe existir").toBe(true);
  });
});
