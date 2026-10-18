import test from "node:test";
import assert from "node:assert/strict";
import { compareYoutubeTags, normalizeYoutubeTag } from "../src/lib/youtube-tag-verification";

test("normalizes Unicode compatibility forms and Turkish casing", () => {
  assert.equal(normalizeYoutubeTag("  ＢİLİM  "), "bilim");
  assert.equal(normalizeYoutubeTag("  Uzay "), "uzay");
});

test("treats tag ordering and case differences as a match", () => {
  assert.deepEqual(compareYoutubeTags(["Bilim", "Uzay"], ["uzay", "BİLİM"]), {
    matches: true,
    missing: [],
    unexpected: [],
  });
});

test("reports missing and unexpected tags with readable values", () => {
  assert.deepEqual(compareYoutubeTags(["Bilim", "Uzay"], ["Bilim", "Tarih"]), {
    matches: false,
    missing: ["Uzay"],
    unexpected: ["Tarih"],
  });
});

test("ignores duplicate normalized spellings", () => {
  assert.deepEqual(compareYoutubeTags(["Bilim", "BİLİM"], ["bilim"]), {
    matches: true,
    missing: [],
    unexpected: [],
  });
});

test("empty expected tags match a read-back with no tags", () => {
  assert.deepEqual(compareYoutubeTags([], []), {
    matches: true,
    missing: [],
    unexpected: [],
  });
});
