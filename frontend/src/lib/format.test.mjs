import test from "node:test";
import assert from "node:assert/strict";
import { plural } from "./format.js";

test("plural usa el singular con 1 y el plural con el resto", () => {
  assert.equal(plural(1, "sesión", "sesiones"), "sesión");
  assert.equal(plural(0, "sesión", "sesiones"), "sesiones");
  assert.equal(plural(2, "sesión", "sesiones"), "sesiones");
  assert.equal(plural(1, "boleta"), "boleta");
  assert.equal(plural(5, "boleta"), "boletas");
});

test("plural acepta el plural por defecto agregando una s", () => {
  assert.equal(plural(1, "transacción", "transacciones"), "transacción");
  assert.equal(plural(3, "transacción", "transacciones"), "transacciones");
});
