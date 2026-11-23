import test from "node:test";
import assert from "node:assert/strict";

import { eventZone, formatEventDate, toZonedInput } from "./eventTime.js";

test("una noche del 30 de septiembre en Bogotá no salta al 1 de octubre", () => {
  // 23:00 del 30/09 en Bogotá = 04:00Z del 01/10. El navegador puede estar en
  // UTC; la tarjeta debe seguir mostrando septiembre.
  const ev = {
    starts_at: "2026-10-01T04:00:00Z",
    event_timezone: "America/Bogota",
  };
  assert.equal(toZonedInput(ev.starts_at, eventZone(ev)), "2026-09-30T23:00");
  const label = formatEventDate(ev.starts_at, eventZone(ev));
  assert.match(label, /30/);
  assert.match(label, /sept/i);
  assert.doesNotMatch(label, /1 de oct/i);
});
