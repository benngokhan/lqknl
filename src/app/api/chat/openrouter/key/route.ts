import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";

// OpenRouter anahtarının panel içi yönetimi (yalnızca oturum açmış kullanıcı — middleware arkasında).
// Anahtar asla yanıtta döndürülmez; yalnızca "kayıtlı mı" bilgisi verilir.
export const runtime = "nodejs";

const KEY_ROW = "openrouter_api_key";

export async function GET() {
  let hasKey = Boolean(process.env.OPENROUTER_API_KEY?.trim());
  if (!hasKey) {
    try {
      const rows = await db.select().from(integrations).where(eq(integrations.key, KEY_ROW));
      hasKey = Boolean((rows[0]?.value as { k?: string } | undefined)?.k?.trim());
    } catch {
      /* DB yoksa env'e göre karar */
    }
  }
  return NextResponse.json({ ok: true, hasKey });
}

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  const key = typeof b.key === "string" ? b.key.trim() : "";
  if (!key.startsWith("sk-or-") || key.length < 40) {
    return NextResponse.json({ ok: false, error: "Geçerli bir OpenRouter anahtarı gir (sk-or- ile başlar)." }, { status: 400 });
  }
  try {
    await db
      .insert(integrations)
      .values({ key: KEY_ROW, value: { k: key } })
      .onConflictDoUpdate({ target: integrations.key, set: { value: { k: key }, updatedAt: new Date() } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Anahtar kaydedilemedi" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
