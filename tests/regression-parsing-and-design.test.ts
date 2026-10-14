import test from "node:test";
import assert from "node:assert/strict";
import { parseDraftScript, HEADINGS, normalizeHeadingName } from "../src/lib/script-parse";
import { normalizeTitleLines, buildMotorDesign } from "../src/lib/motor-render";
const opts = (designSection: string) => ({ designSection, title: "Başlık", topic: "Konu", narration: "Metin", sections: {} });

test("1: Turkish heading normalization", () => {
  assert.equal(normalizeHeadingName("KANCA"), "KANCA");
  assert.equal(normalizeHeadingName("kanca"), "KANCA");
  assert.equal(normalizeHeadingName("görsel tasarımı"), "GÖRSEL TASARIMI");
  assert.equal(normalizeHeadingName("ses ve müzik"), "SES VE MÜZİK");
});
test("2: required headings list contains nine sections", () => {
  assert.equal(HEADINGS.length, 9);
  assert.ok(HEADINGS.includes("TASARIM"));
});
test("3: lowercase Turkish heading parses", () => {
  assert.equal(parseDraftScript("kanca:\nBir giriş").KANCA, "Bir giriş");
});
test("4: numbered headings parse", () => {
  assert.equal(parseDraftScript("1. KANCA\nGiriş\n9. TASARIM\n{}").TASARIM, "{}");
});
test("5: six-level Markdown heading parses", () => {
  assert.equal(parseDraftScript("###### SESLENDİRME\nMerhaba").SESLENDİRME, "Merhaba");
});
test("6: bold heading with colon inside bold markers parses", () => {
  assert.equal(parseDraftScript("**TASARIM:**\n{}").TASARIM, "{}");
});
test("7: optional parenthetical JSON suffix parses", () => {
  assert.equal(parseDraftScript("TASARIM (JSON):\n{}").TASARIM, "{}");
});
test("8: flat title strings normalize and last line is green", () => {
  assert.deepEqual(normalizeTitleLines(["SATIR 1", "SON SATIR"]), [["SATIR 1"], [["SON SATIR", "g"]]]);
});
test("9: multiline title text normalizes", () => {
  assert.deepEqual(normalizeTitleLines("SATIR 1\nSON SATIR"), [["SATIR 1"], [["SON SATIR", "g"]]]);
});
test("10: nested title segments remain compatible", () => {
  assert.deepEqual(normalizeTitleLines([["SATIR 1"], [["SATIR 2", "g"]]]), [["SATIR 1"], [["SATIR 2", "g"]]]);
});
test("11: hybrid title arrays normalize", () => {
  assert.deepEqual(normalizeTitleLines(["SATIR 1", ["SON SATIR", "g"]]), [["SATIR 1"], [["SON SATIR", "g"]]]);
});
test("12: design quality gate rejects missing fields, empty title and invalid JSON", () => {
  for (const json of ['{"title":["A"],"note2":"B"}','{"title":["A"],"note1":"B"}','{"title":[],"note1":"A","note2":"B"}','{"title":[bad json}']) {
    assert.throws(() => buildMotorDesign(opts(json)), /TASARIM bloğu bulunamadı/);
  }
  assert.throws(() => buildMotorDesign(opts("")), /TASARIM bloğu bulunamadı/);
});
