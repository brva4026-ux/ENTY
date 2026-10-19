/**
 * Limpieza de los eventos que crean los E2E (prefijo E2E-).
 *
 * Sin esto la DB de desarrollo acumula eventos de prueba entre corridas. El
 * catalogo publico ordena por `starts_at ASC` (public.py), asi que un evento
 * E2E con fecha cercana se cuela al frente y desplaza al del seed: los specs
 * que eligen "el primer evento del catalogo" (fan, fan-checkout) empiezan a
 * ver un evento agotado y caen en rojo por datos, no por codigo.
 *
 * Corre como globalTeardown (una vez por suite). Borra por la API real
 * (DELETE /events/{id}) para no depender del esquema: el endpoint finaliza
 * primero los `live` (no se pueden borrar con las puertas abiertas).
 */
const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8001";
const ADMIN = { email: "admin@bar.test", password: "demo1234" };

export default async function globalTeardown() {
  let token;
  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN),
    });
    if (!res.ok) return;
    token = (await res.json()).access_token;
  } catch {
    return; // backend caido: los specs ya se saltaron solos
  }
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  let venue;
  try {
    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: auth })).json();
    venue = Number(Object.keys(me.roles)[0]);
  } catch {
    return;
  }
  if (!venue) return;

  let events = [];
  try {
    events = await (await fetch(`${BASE}/api/venues/${venue}/events`, { headers: auth })).json();
  } catch {
    return;
  }

  for (const ev of events) {
    if (!ev.name?.startsWith("E2E-")) continue;
    // `live` no se borra: se finaliza y luego se intenta el borrado.
    if (ev.status === "live") {
      await fetch(`${BASE}/api/venues/${venue}/events/${ev.id}/end`, {
        method: "POST",
        headers: auth,
      }).catch(() => {});
    }
    await fetch(`${BASE}/api/venues/${venue}/events/${ev.id}`, {
      method: "DELETE",
      headers: auth,
      body: JSON.stringify({ confirm: ev.name }),
    }).catch(() => {});
  }
}
