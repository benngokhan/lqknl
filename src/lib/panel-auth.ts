// Panel erişim kontrolü — şifre hash'i Postgres "integrations" tablosunda kalıcı tutulur.
// Default şifre: 4444 (ilk panel içi değişiklikle değiştirilince DB'ye hash yazılır).
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { db } from "@/db";
import { integrations } from "@/db/schema";

const KEY = "panel_password";
export const DEFAULT_PANEL_PASSWORD = process.env.PANEL_PASSWORD?.trim() || "4444";
export const AUTH_SECRET = process.env.PANEL_AUTH_SECRET?.trim() || "kpn-static-fallback-7f3a9c21b8e4";
export const AUTH_COOKIE = "kpn_auth";
export const SESSION_DAYS = 30;

type PwRec = { salt: string; hash: string };

function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

let cache: { at: number; rec: PwRec } | null = null;

function defaultRec(): PwRec {
  return { salt: "default", hash: sha256hex("default" + DEFAULT_PANEL_PASSWORD) };
}

async function getPwRec(): Promise<PwRec> {
  if (cache && Date.now() - cache.at < 60_000) return cache.rec;
  try {
    const rows = await db.select().from(integrations).where(eq(integrations.key, KEY));
    const stored = rows[0]?.value as PwRec | undefined;
    const rec = stored && typeof stored.salt === "string" && typeof stored.hash === "string" ? stored : defaultRec();
    cache = { at: Date.now(), rec };
    return rec;
  } catch {
    return defaultRec(); // DB erişilemezse default şifreyle çalış (panel kilitlenmesin)
  }
}

export async function verifyPanelPassword(password: string): Promise<boolean> {
  const rec = await getPwRec();
  const a = sha256hex(rec.salt + password);
  const b = rec.hash;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export async function changePanelPassword(next: string): Promise<void> {
  if (next.length < 4) throw new Error("Yeni şifre en az 4 karakter olmalı.");
  const salt = crypto.randomBytes(8).toString("hex");
  const rec: PwRec = { salt, hash: sha256hex(salt + next) };
  await db
    .insert(integrations)
    .values({ key: KEY, value: rec })
    .onConflictDoUpdate({ target: integrations.key, set: { value: rec, updatedAt: new Date() } });
  cache = { at: Date.now(), rec };
}

export function signToken(): { token: string; maxAge: number } {
  const maxAge = SESSION_DAYS * 86_400;
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(String(exp)).digest("hex");
  return { token: `${exp}.${sig}`, maxAge };
}

export function verifyToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const i = token.indexOf(".");
  if (i < 1) return false;
  const exp = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return false;
  const expect = crypto.createHmac("sha256", AUTH_SECRET).update(exp).digest("hex");
  return sig === expect;
}
