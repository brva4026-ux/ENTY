import assert from "node:assert/strict";
import test from "node:test";

import { isValidUsername, normalizeUsername, usernameBase } from "./username.js";

test("normalizeUsername quita la arroba, tildes y mayúsculas", () => {
  assert.equal(normalizeUsername("  @Ana.Gómez  "), "ana.gomez");
});

test("usernameBase genera una base válida desde el nombre del negocio", () => {
  assert.equal(usernameBase("Casa Azul"), "casa.azul");
  assert.equal(usernameBase("Bar La Esquina 2"), "bar.la.esquina.2");
  assert.equal(usernameBase("  --  "), "usuario");
});

test("usernameBase recorta a 32 y no deja separadores al final", () => {
  const base = usernameBase("a".repeat(40));
  assert.equal(base.length, 32);
  assert.ok(isValidUsername(base));
  assert.equal(usernameBase("ab"), "usuario");
});
