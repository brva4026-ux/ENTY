import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheKey, dedupeGet, invalidate, invalidatePrefix, __reset } from "./apiCache.js";

test("dos llamadas concurrentes idénticas comparten UNA petición", async () => {
  __reset();
  let calls = 0;
  const run = () => {
    calls += 1;
    return new Promise((r) => setTimeout(() => r("dato"), 10));
  };
  const [a, b] = await Promise.all([
    dedupeGet("GET /x anon", run),
    dedupeGet("GET /x anon", run),
  ]);
  assert.equal(calls, 1, "solo se ejecutó una vez");
  assert.equal(a, "dato");
  assert.equal(b, "dato");
});

test("claves distintas NO se comparten", async () => {
  __reset();
  let calls = 0;
  const run = () => {
    calls += 1;
    return Promise.resolve(calls);
  };
  await Promise.all([dedupeGet("GET /a anon", run), dedupeGet("GET /b anon", run)]);
  assert.equal(calls, 2);
});

test("un fallo no queda pegado: el siguiente intento reintenta", async () => {
  __reset();
  let calls = 0;
  const fail = () => {
    calls += 1;
    return Promise.reject(new Error("boom"));
  };
  await assert.rejects(() => dedupeGet("GET /f anon", fail));
  await assert.rejects(() => dedupeGet("GET /f anon", fail));
  assert.equal(calls, 2, "se reintentó en vez de servir la promesa rota");
});

test("TTL sirve lo reciente sin volver a la red, y expira", async () => {
  __reset();
  let calls = 0;
  const run = () => {
    calls += 1;
    return Promise.resolve(calls);
  };
  const first = await dedupeGet("GET /t anon", run, { ttlMs: 50 });
  const second = await dedupeGet("GET /t anon", run, { ttlMs: 50 });
  assert.equal(first, 1);
  assert.equal(second, 1, "segunda vino del micro-caché");
  assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 60));
  const third = await dedupeGet("GET /t anon", run, { ttlMs: 50 });
  assert.equal(third, 2, "tras el TTL vuelve a la red");
});

test("bypass ignora lo reciente pero conserva la coalescencia", async () => {
  __reset();
  let calls = 0;
  const run = () => {
    calls += 1;
    return Promise.resolve(calls);
  };
  await dedupeGet("GET /b anon", run, { ttlMs: 10_000 });
  const freshVal = await dedupeGet("GET /b anon", run, {
    ttlMs: 10_000,
    bypass: true,
  });
  assert.equal(freshVal, 2, "bypass fuerza red");
  assert.equal(calls, 2);
});

test("la clave separa por token (sesión) y por método", () => {
  assert.notEqual(cacheKey("GET", "/x", "tok"), cacheKey("GET", "/x", ""));
  assert.equal(cacheKey("get", "/x", "tok"), "GET /x auth");
});

test("invalidatePrefix borra solo lo que corresponde", async () => {
  __reset();
  let calls = 0;
  const run = () => {
    calls += 1;
    return Promise.resolve(calls);
  };
  await dedupeGet("GET /venues/3/events anon", run, { ttlMs: 10_000 });
  await dedupeGet("GET /venues/4/events anon", run, { ttlMs: 10_000 });
  invalidatePrefix("/venues/3/");
  const a = await dedupeGet("GET /venues/3/events anon", run, { ttlMs: 10_000 });
  const b = await dedupeGet("GET /venues/4/events anon", run, { ttlMs: 10_000 });
  assert.equal(a, 3, "la invalidada volvió a la red");
  assert.equal(b, 2, "la otra siguió cacheada");
  invalidate("GET /venues/4/events anon");
  const c = await dedupeGet("GET /venues/4/events anon", run, { ttlMs: 10_000 });
  assert.equal(c, 4);
});
