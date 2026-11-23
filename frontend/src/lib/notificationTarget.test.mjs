import test from "node:test";
import assert from "node:assert/strict";

import { adminTarget } from "./notificationTarget.js";

test("aforo y reemisión abren el evento en su sección", () => {
  assert.equal(
    adminTarget({ kind: "capacity_alert", link: "/admin?event=7&tab=accesos" }),
    "/admin?event=7&tab=accesos",
  );
  assert.equal(
    adminTarget({ kind: "ticket_reissued", link: "/admin?event=9&tab=ventas" }),
    "/admin?event=9&tab=ventas",
  );
});

test("los avisos sin evento caen en Eventos, no en un backstage inventado", () => {
  assert.equal(adminTarget({ kind: "capacity_alert", link: "/admin" }), "/admin");
  assert.equal(adminTarget({ kind: "ticket_reissued", link: "/admin" }), "/admin");
});

test("las pestañas viejas se traducen a Organización o Reportes", () => {
  assert.equal(
    adminTarget({ kind: "invitation_accepted", link: "/admin?tab=equipo" }),
    "/admin/organizacion?tab=equipo",
  );
  assert.equal(
    adminTarget({ kind: "payout_created", link: "/admin?tab=liquidaciones" }),
    "/admin/reportes?tab=ventas",
  );
});

test("un aviso de staff no se redirige a Administración", () => {
  assert.equal(
    adminTarget({ kind: "event_reminder", link: "/bouncer?evento=3" }),
    "/bouncer?evento=3",
  );
  assert.equal(
    adminTarget({ kind: "event_reminder", link: "/promotor" }),
    "/promotor",
  );
});
