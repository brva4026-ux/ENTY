import { chromium } from "@playwright/test";

const BASE = "https://ticketflow-git-master-brva4026-uxs-projects.vercel.app";
const ROUTES = ["/inicio", "/login", "/registro"];

const browser = await chromium.launch();
const failures = [];

for (const route of ROUTES) {
  for (const scheme of ["dark", "light"]) {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 850 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    try {
      await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(1500);
      const r = await page.evaluate(() => {
        const root = document.getElementById("root");
        const blocks = [...root.querySelectorAll("*")].filter((e) => {
          const cs = getComputedStyle(e);
          const b = e.getBoundingClientRect();
          return (
            cs.display !== "none" &&
            cs.visibility !== "hidden" &&
            +cs.opacity > 0.1 &&
            b.width > 60 &&
            b.height > 24 &&
            (e.innerText || "").trim().length > 3
          );
        }).length;
        return { blocks };
      });
      const label = `${route} [${scheme}] bloquesVisibles=${r.blocks}`;
      if (r.blocks < 3 || pageErrors.length) {
        failures.push(`${label} ${pageErrors.join("; ")}`);
        console.log("FALLO  " + label + (pageErrors.length ? " | " + pageErrors[0] : ""));
      } else {
        console.log("OK     " + label);
      }
    } catch (e) {
      failures.push(`${route} [${scheme}] ${e.message}`);
      console.log("ERROR  " + route + " [" + scheme + "] " + e.message);
    }
    await ctx.close();
  }
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} comprobación(es) fallida(s).`);
  process.exit(1);
}
console.log("\nTodas las rutas renderizan contenido visible en ambos temas.");