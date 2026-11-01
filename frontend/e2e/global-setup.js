/**
 * Setup global de Playwright: garantiza el seed demo antes de la suite.
 *
 * La suite asume los datos demo (usuarios, venue y el evento del catalogo). El
 * job `e2e` de CI los siembra en un paso propio, pero al correr en local nadie
 * lo hacia: con una base recien creada faltaba el evento del seed y specs como
 * fan.spec.js fallaban por datos, no por codigo. Este setup replica ese paso.
 *
 * `POST /seed` es idempotente (todas sus escrituras son `ON CONFLICT DO
 * NOTHING`), asi que invocarlo siempre es seguro: no borra ni pisa nada.
 *
 * No es un gate: si la app no responde, o el backend tiene IS_DEMO apagado, se
 * avisa y se continua, respetando el "si no hay app, el test se salta solo" que
 * ya usan las specs.
 */
const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";

export default async function globalSetup() {
  let health;
  try {
    health = await fetch(`${BASE}/api/health`);
  } catch {
    console.warn(
      `\n[e2e] App no disponible en ${BASE}: no se siembra. Las specs se saltaran solas.\n`,
    );
    return;
  }
  if (!health.ok) {
    console.warn(`\n[e2e] /api/health respondio ${health.status}: no se siembra.\n`);
    return;
  }

  const seed = await fetch(`${BASE}/api/seed`, { method: "POST" });
  if (seed.status === 403) {
    console.warn(
      "\n[e2e] El backend tiene IS_DEMO apagado: no se pudo sembrar.\n" +
        "      Si faltan los datos demo, arrancalo con IS_DEMO=true.\n",
    );
    return;
  }
  if (!seed.ok) {
    console.warn(`\n[e2e] El seed respondio ${seed.status}: se sigue con los datos actuales.\n`);
    return;
  }

  const data = await seed.json().catch(() => null);
  console.log(
    `[e2e] Seed demo listo (venue ${data?.venue_id ?? "?"}, evento ${data?.event_id ?? "?"}).`,
  );
}
