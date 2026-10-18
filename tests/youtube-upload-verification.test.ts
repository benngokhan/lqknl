import test from "node:test";
import assert from "node:assert/strict";
import { compareYoutubeUploadMetadata } from "../src/lib/youtube-upload-verification";

const expected = {
  title: "Bilim ve Uzay",
  description: "Açıklama satırı\nİkinci satır",
  tags: ["Bilim", "Uzay"],
  privacyStatus: "private",
  publishAt: "2026-10-20T12:00:00.000Z",
};

test("accepts matching metadata despite tag order and case differences", () => {
  assert.deepEqual(compareYoutubeUploadMetadata(expected, {
    title: "Bilim ve Uzay",
    description: "Açıklama satırı\r\nİkinci satır",
    tags: ["uzay", "BİLİM"],
    privacyStatus: "private",
    publishAt: "2026-10-20T12:00:00Z",
  }), { matches: true, mismatches: [] });
});

test("reports all mismatched upload fields", () => {
  const result = compareYoutubeUploadMetadata(expected, {
    title: "Yanlış başlık",
    description: "Farklı açıklama",
    tags: ["Bilim", "Tarih"],
    privacyStatus: "public",
    publishAt: "2026-10-21T12:00:00Z",
  });
  assert.equal(result.matches, false);
  assert.deepEqual(result.mismatches, [
    "title",
    "description",
    "tags (missing=Uzay; unexpected=Tarih)",
    "privacyStatus",
    "publishAt",
  ]);
});

test("does not require publishAt when the upload is not scheduled", () => {
  assert.deepEqual(compareYoutubeUploadMetadata({
    title: "Başlık",
    description: "",
    tags: [],
    privacyStatus: "private",
  }, {
    title: "Başlık",
    description: "",
    tags: [],
    privacyStatus: "private",
  }), { matches: true, mismatches: [] });
});
