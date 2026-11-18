import { test } from "node:test";
import assert from "node:assert/strict";
import { lookup, translate, flattenKeys, LOCALES } from "../lib/i18nCore.js";
import es from "../i18n/es.js";
import en from "../i18n/en.js";

const CATALOGS = { es, en };

test("es y en tienen exactamente las mismas claves", () => {
  const esKeys = flattenKeys(es);
  const enKeys = flattenKeys(en);
  const missingInEn = esKeys.filter((k) => !enKeys.includes(k));
  const missingInEs = enKeys.filter((k) => !esKeys.includes(k));
  assert.deepEqual(
    missingInEn,
    [],
    `faltan en en.js: ${missingInEn.join(", ")}`,
  );
  assert.deepEqual(
    missingInEs,
    [],
    `faltan en es.js: ${missingInEs.join(", ")}`,
  );
});

test("todas las hojas de los catalogos son cadenas no vacias", () => {
  for (const loc of LOCALES) {
    for (const key of flattenKeys(CATALOGS[loc])) {
      const val = lookup(CATALOGS[loc], key);
      assert.equal(
        typeof val,
        "string",
        `${loc}.${key} no es una cadena`,
      );
      assert.ok(val.trim().length > 0, `${loc}.${key} esta vacia`);
    }
  }
});

test("translate devuelve el texto y camina rutas anidadas", () => {
  assert.equal(translate(es, "login.title"), "Iniciar sesión");
  assert.equal(translate(en, "login.title"), "Sign in");
  assert.equal(translate(es, "login.errors.network").startsWith("No hay"), true);
});

test("translate devuelve la CLAVE si falta (no rompe el render)", () => {
  assert.equal(translate(es, "login.noExiste"), "login.noExiste");
  assert.equal(translate(es, "noExiste.ni.esto"), "noExiste.ni.esto");
});

test("translate interpola {marcadores}", () => {
  const cat = { hi: "Hola {name}, tienes {n} boletas" };
  assert.equal(
    translate(cat, "hi", { name: "Ana", n: 3 }),
    "Hola Ana, tienes 3 boletas",
  );
  // Marcador sin valor: se deja literal (mejor visible que vacio).
  assert.equal(translate(cat, "hi", { name: "Ana" }), "Hola Ana, tienes {n} boletas");
});
