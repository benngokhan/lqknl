import test from "node:test";
import assert from "node:assert/strict";
import { requestedScheduleSlots } from "../src/lib/youtube-schedule-slots";

const now = new Date("2026-10-17T10:00:00.000Z");

test("parses two through four future Turkey-local schedule slots", () => {
  assert.equal(requestedScheduleSlots("18 Ekim 2026 saat 10:00 ve 12:00", now)?.length, 2);
  assert.equal(requestedScheduleSlots("18 Ekim 2026 10:00, 12:00, 14:00, 16:00", now)?.length, 4);
  assert.equal(requestedScheduleSlots("18 Ekim 2026 10:00, 12:00, 14:00", now)?.length, 3);
});

test("rejects missing, invalid, duplicate, unordered, or past slots", () => {
  assert.equal(requestedScheduleSlots("18 Ekim 2026", now), null);
  assert.equal(requestedScheduleSlots("18 Ekim 2026 10:00, 10:00", now), null);
  assert.equal(requestedScheduleSlots("18 Ekim 2026 12:00, 10:00", now), null);
  assert.equal(requestedScheduleSlots("18 Ekim 2026 25:00, 26:00", now), null);
  assert.equal(requestedScheduleSlots("17 Ekim 2026 10:00, 12:00", now), null);
  assert.equal(requestedScheduleSlots("31 Şubat 2027 10:00, 12:00", now), null);
  assert.equal(requestedScheduleSlots("18 Ekim 2026 10:00, 12:00, 14:00, 16:00, 18:00", now), null);
});
