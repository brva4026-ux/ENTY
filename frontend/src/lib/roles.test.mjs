import assert from "node:assert/strict";
import test from "node:test";

import {
  destinationFor,
  operationalRoles,
  pathAllowsRole,
  preferredRoleFor,
  roleIdentity,
  roleI18nKey,
  taskFromPath,
} from "./roles.js";

const user = {
  roles: {
    1: ["admin", "promotor"],
    2: ["bouncer"],
  },
};

test("operationalRoles ordena y pliega super_admin en Administración", () => {
  assert.deepEqual(operationalRoles(user), ["admin", "promotor", "bouncer"]);
  assert.deepEqual(
    operationalRoles({ roles: { 1: ["super_admin", "promotor"] } }),
    ["super_admin", "promotor"],
  );
});

test("la tarea de puerta manda sobre el rol más alto", () => {
  const roles = operationalRoles(user);
  assert.equal(preferredRoleFor(user, roles, { kind: "door" }, null), "bouncer");
  assert.equal(
    destinationFor(
      "bouncer",
      "/puerta?token=abc",
      { kind: "door" },
    ),
    "/puerta?token=abc",
  );
});

test("la invitación conserva el rol que propone el enlace", () => {
  const roles = operationalRoles(user);
  assert.equal(
    preferredRoleFor(
      user,
      roles,
      { kind: "invitation", role: "promotor" },
      "/invitacion?token=abc",
    ),
    "promotor",
  );
});

test("un from autorizado gana; uno ajeno cae al destino del rol", () => {
  assert.equal(destinationFor("admin", "/admin/reportes", null), "/admin/reportes");
  assert.equal(destinationFor("promotor", "/admin", null), "/promotor");
  assert.equal(destinationFor("bouncer", "/promotor", null), "/bouncer");
});

test("taskFromPath solo reconoce puerta e invitación", () => {
  assert.deepEqual(taskFromPath("/puerta?token=x"), { kind: "door" });
  assert.deepEqual(taskFromPath("/invitacion?token=x"), { kind: "invitation" });
  assert.equal(taskFromPath("/admin"), null);
  assert.equal(taskFromPath(null), null);
});

test("pathAllowsRole respeta el ámbito de cada herramienta", () => {
  assert.equal(pathAllowsRole("/admin/reportes", "admin"), true);
  assert.equal(pathAllowsRole("/admin/reportes", "super_admin"), true);
  assert.equal(pathAllowsRole("/admin/reportes", "promotor"), false);
  assert.equal(pathAllowsRole("/promotor", "promotor"), true);
  assert.equal(pathAllowsRole("/bouncer", "bouncer"), true);
  assert.equal(pathAllowsRole("/boletas", "bouncer"), true);
});

test("la identidad visible usa el copy exacto de cada rol", () => {
  assert.equal(roleIdentity("admin").welcome, "Bienvenido a Administración");
  assert.equal(roleIdentity("promotor").welcome, "Tu espacio de promotor");
  assert.equal(roleIdentity("bouncer").welcome, "Tu acceso de Puerta");
  assert.equal(roleIdentity("super_admin").welcome, "Bienvenido a Administración");
});

test("un rol interno desconocido no hereda el acento ni el destino de Puerta", () => {
  const identity = roleIdentity("auditor_interno");
  assert.equal(identity.label, "Acceso");
  assert.equal(identity.home, "/login");
  assert.equal(identity.accent, "admin");
  assert.equal(roleI18nKey("super_admin"), "admin");
});
