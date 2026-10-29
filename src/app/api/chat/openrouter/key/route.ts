import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";

// OpenRouter anahtarının panel içi yönetimi (yalnızca oturum açmış kullanıcı — middleware arkasında).
// Anahtar asla yanıtta döndürülmez; yalnızca "kayıtlı mı" bilgisi verilir.
export const runtime = "nodejs";

const KEY_ROW = "openrouter_api_key";

export async function GET() {
  const envKey = process.env.OPENROUTER_API_KEY?.trim() || "";
  let dbKey = "";
  try {
    const rows = await db.select().from(integrations).where(eq(integrations.key, KEY_ROW));
    dbKey = (rows[0]?.value as { k?: string } | undefined)?.k?.trim() || "";
  } catch {
    /* DB yoksa env'e göre karar */
  }
  const active = envKey || dbKey;
  return NextResponse.json({
    ok: true,
    hasKey: Boolean(active),
    // Doğrulama için: anahtarın kendisi DEĞİL, parmak izi (başlangıç + uzunluk + sha256 özeti)
    prefix: active ? `${active.slice(0, 8)}…${active.slice(-4)}` : "",
    len: active.length,
    sha: active ? createHash("sha256").update(active).digest("hex").slice(0, 16) : "",
  });
}

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  const key = typeof b.key === "string" ? b.key.trim() : "";
  if (!key.startsWith("sk-or-") || key.length < 40) {
    return NextResponse.json({ ok: false, error: "Geçerli bir OpenRouter anahtarı gir (sk-or- ile başlar)." }, { status: 400 });
  }
  try {
    const rows = await db.select().from(integrations).where(eq(integrations.key, KEY_ROW));
    if (rows.length > 0) {
      await db
        .update(integrations)
        .set({ value: { k: key }, updatedAt: new Date() })
        .where(eq(integrations.key, KEY_ROW));
    } else {
      await db.insert(integrations).values({ key: KEY_ROW, value: { k: key } });
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Anahtar kaydedilemedi" },
      { status: 500 },
    );
  }
  // Okuma geri-dogrulama (debug): yazimdan sonra DB'den yeniden oku
  let dbSha = "";
  let dbLen = 0;
  let dbPrefix = "";
  try {
    const after = await db.select().from(integrations).where(eq(integrations.key, KEY_ROW));
    const k2 = (after[0]?.value as { k?: string } | undefined)?.k?.trim() || "";
    dbSha = k2 ? createHash("sha256").update(k2).digest("hex").slice(0, 16) : "";
    dbLen = k2.length;
    dbPrefix = k2 ? `${k2.slice(0, 8)}…${k2.slice(-4)}` : "";
  } catch {
    /* okunamadi */
  }
  const envK = process.env.OPENROUTER_API_KEY?.trim() || "";
  return NextResponse.json({
    ok: true,
    prefix: `${key.slice(0, 8)}…${key.slice(-4)}`,
    len: key.length,
    sha: createHash("sha256").update(key).digest("hex").slice(0, 16),
    dbPrefix,
    dbLen,
    dbSha,
    envSet: Boolean(envK),
    envSha: envK ? createHash("sha256").update(envK).digest("hex").slice(0, 16) : "",
  });
}
