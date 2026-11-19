import test from "node:test";
import assert from "node:assert/strict";
import { slowConnection, richMotion } from "./perf.js";

/** navigator falso: solo lo que `slowConnection` consulta. */
const nav = (connection) => ({ connection });

/**
 * Ejecuta `fn` con globals sustituidos. En node 24 `navigator` es un getter
 * de solo lectura, así que se reemplaza con `defineProperty` y se restaura
 * al salir (si no, un test contamina al siguiente).
 */
function withGlobals(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  try {
    return fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
}

const noReduce = { matchMedia: () => ({ matches: false }) };
const noStore = { getItem: () => null };

test("sin navigator.connection no se degrada: Safari y Firefox van completos", () => {
  assert.equal(slowConnection({}), false);
  assert.equal(slowConnection(null), false);
});

test("2G y 3G son red lenta; 4G y desconocida no", () => {
  for (const t of ["slow-2g", "2g", "3g"]) {
    assert.equal(slowConnection(nav({ effectiveType: t })), true, t);
  }
  for (const t of ["4g", undefined]) {
    assert.equal(slowConnection(nav({ effectiveType: t })), false, String(t));
  }
});

test("saveData apaga la capa rica aunque la red sea rapida", () => {
  assert.equal(slowConnection(nav({ effectiveType: "4g", saveData: true })), true);
  assert.equal(slowConnection(nav({ effectiveType: "4g", saveData: false })), false);
});

test("richMotion se apaga si la app pide movimiento reducido", () => {
  const off = withGlobals(
    {
      window: noReduce,
      localStorage: { getItem: (k) => (k === "tf_motion" ? "reduce" : null) },
      navigator: nav({ effectiveType: "4g" }),
    },
    () => richMotion(),
  );
  assert.equal(off, false);
});

test("richMotion se apaga con red lenta y se enciende en red normal", () => {
  withGlobals(
    { window: noReduce, localStorage: noStore, navigator: nav({ effectiveType: "3g" }) },
    () => assert.equal(richMotion(), false),
  );
  withGlobals(
    { window: noReduce, localStorage: noStore, navigator: nav({ effectiveType: "4g" }) },
    () => assert.equal(richMotion(), true),
  );
});

test("richMotion respeta prefers-reduced-motion del sistema", () => {
  const on = withGlobals(
    {
      window: { matchMedia: () => ({ matches: true }) },
      localStorage: noStore,
      navigator: nav({ effectiveType: "4g" }),
    },
    () => richMotion(),
  );
  assert.equal(on, false);
});
