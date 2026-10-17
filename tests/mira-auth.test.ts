import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createMiraSessionValue, isMiraSessionCookie } from "../src/lib/mira-auth";

const secret = "test-password";
process.env.MIRA_ENTRY_PASSWORD = secret;
delete process.env.MIRA_SESSION_SECRET;

test("accepts a valid signed session and rejects a forged cookie", () => {
  const value = createMiraSessionValue(1_800_000_000_000);
  assert.equal(isMiraSessionCookie("other=x; mira_entry=" + value, 1_800_000_001_000), true);
  assert.equal(isMiraSessionCookie("mira_entry=1", 1_800_000_001_000), false);
  assert.equal(isMiraSessionCookie("mira_entry=v1.1800000000." + "0".repeat(64), 1_800_000_001_000), false);
});

test("rejects expired and future-dated sessions", () => {
  const value = createMiraSessionValue(1_800_000_000_000);
  assert.equal(isMiraSessionCookie("mira_entry=" + value, 1_800_000_000_000 + 7 * 24 * 60 * 60 * 1000 + 1000), false);
  assert.equal(isMiraSessionCookie("mira_entry=" + value, 1_800_000_000_000 - 120_000), false);
});

test("accepts configured session secret and validates signature", () => {
  process.env.MIRA_SESSION_SECRET = "separate-session-secret";
  const issued = 1_800_000_000_000;
  const payload = "v1." + Math.floor(issued / 1000);
  const signature = createHmac("sha256", process.env.MIRA_SESSION_SECRET).update(payload).digest("hex");
  assert.equal(isMiraSessionCookie("mira_entry=" + payload + "." + signature, issued), true);
  process.env.MIRA_SESSION_SECRET = "";
  assert.equal(isMiraSessionCookie("mira_entry=" + payload + "." + signature, issued), false);
});
