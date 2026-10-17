import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "mira_entry";
const SESSION_SECONDS = 7 * 24 * 60 * 60;

function sessionSecret() {
  return process.env.MIRA_SESSION_SECRET?.trim() || process.env.MIRA_ENTRY_PASSWORD?.trim() || "";
}

export function createMiraSessionValue(now = Date.now()) {
  const secret = sessionSecret();
  if (!secret) throw new Error("MIRA_ENTRY_PASSWORD is not configured.");
  const payload = `v1.${Math.floor(now / 1000)}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

export function isMiraSessionCookie(cookieHeader: string | null | undefined, now = Date.now()) {
  const secret = sessionSecret();
  if (!secret || !cookieHeader) return false;
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return false;
  const value = cookie.slice(COOKIE_NAME.length + 1);
  const match = value.match(/^v1\.(\d{10})\.([a-f0-9]{64})$/);
  if (!match) return false;
  const issuedAt = Number(match[1]);
  const nowSeconds = Math.floor(now / 1000);
  if (issuedAt > nowSeconds + 60 || nowSeconds - issuedAt > SESSION_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`v1.${match[1]}`).digest();
  const supplied = Buffer.from(match[2], "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
