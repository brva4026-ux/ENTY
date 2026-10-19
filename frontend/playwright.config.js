/**
 * Config de Playwright para los E2E del flujo crítico.
 *
 * Corre contra un backend REAL (E2E_BASE_URL, default 127.0.0.1:8001, el
 * puerto de run.py) con el seed demo vigente. No usa el dev server de Vite:
 * el app shell servido por el backend es el mismo de producción.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";
// package.json es "type": "module": __dirname no existe; se deriva de la URL.
const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  testDir: here,
  // Borra los eventos E2E- que quedan de cada corrida: sin esto se acumulan y
  // desplazan al evento del seed en el catalogo (orden por starts_at ASC),
  // volviendo rojos los specs que eligen "el primer evento" por datos, no por
  // codigo. Ver e2e/global-teardown.js.
  globalTeardown: here + "e2e/global-teardown.js",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: BASE,
    headless: true,
    // La puerta es móvil primero; el admin se revisa en desktop aparte.
    viewport: { width: 420, height: 860 },
    actionTimeout: 8_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
