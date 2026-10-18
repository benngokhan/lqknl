import test from "node:test";
import assert from "node:assert/strict";
import { driveVideoNumberFromFilename, readDriveVideoMetadata } from "../src/lib/drive-video-metadata";

test("reads title, description, tags and comment from the matching VIDEO block only", () => {
  const markdown = [
    "## VIDEO 1",
    "BAŞLIK: Birinci başlık",
    "AÇIKLAMA: Birinci açıklama satırı",
    "İkinci açıklama satırı",
    "ETİKETLER: uzay, bilim, #astronomi",
    "SABİT YORUM: Yorum metni",
    "## VIDEO 2",
    "BAŞLIK: İkinci başlık",
    "AÇIKLAMA: İkinci açıklama",
    "ETİKETLER: tarih, bilgi",
  ].join("\n");
  assert.deepEqual(readDriveVideoMetadata(markdown, 1), {
    title: "Birinci başlık",
    description: "Birinci açıklama satırı\nİkinci açıklama satırı",
    tags: ["uzay", "bilim", "astronomi"],
    pinnedComment: "Yorum metni",
  });
  assert.equal(readDriveVideoMetadata(markdown, 2).title, "İkinci başlık");
});

test("rejects missing or invalid video metadata instead of inventing it", () => {
  assert.throws(() => readDriveVideoMetadata("## VIDEO 2\nBAŞLIK: Başlık", 1), /VIDEO 1 bölümü/);
  assert.throws(() => readDriveVideoMetadata("## VIDEO 1\nAÇIKLAMA: Açıklama", 1), /BAŞLIK alanı/);
  assert.throws(() => readDriveVideoMetadata("## VIDEO 1\nBAŞLIK: Başlık", 0), /Geçersiz video numarası/);
});

test("maps supported Drive video filenames to their metadata block number", () => {
  assert.equal(driveVideoNumberFromFilename("video_1.mp4"), 1);
  assert.equal(driveVideoNumberFromFilename("uzun_video_12.mp4"), 12);
  assert.equal(driveVideoNumberFromFilename("VIDEO_007.MP4"), 7);
  assert.throws(() => driveVideoNumberFromFilename("video_0.mp4"), /1 ile 999/);
  assert.throws(() => driveVideoNumberFromFilename("video_1000.mp4"), /1 ile 999/);
  assert.throws(() => driveVideoNumberFromFilename("other.mp4"), /biçiminde olmalı/);
});
