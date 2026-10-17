import test from "node:test";
import assert from "node:assert/strict";
import { isYoutubeScheduleCancellation, isYoutubeScheduleConfirmation } from "../src/lib/youtube-schedule-approval";

test("YouTube schedule requires an explicit approval phrase", () => {
  assert.equal(isYoutubeScheduleConfirmation("Planı onayla"), true);
  assert.equal(isYoutubeScheduleConfirmation("  ONAYLIYORUM  "), true);
  assert.equal(isYoutubeScheduleConfirmation("evet"), false);
  assert.equal(isYoutubeScheduleConfirmation("YouTube'a yükle"), false);
  assert.equal(isYoutubeScheduleConfirmation("Planı onayla ve herkese açık yap"), false);
});

test("YouTube schedule cancellation is explicit and separate from approval", () => {
  assert.equal(isYoutubeScheduleCancellation("Planı iptal et"), true);
  assert.equal(isYoutubeScheduleCancellation("Vazgeç"), true);
  assert.equal(isYoutubeScheduleCancellation("onaylıyorum"), false);
  assert.equal(isYoutubeScheduleCancellation("hayır"), false);
});
