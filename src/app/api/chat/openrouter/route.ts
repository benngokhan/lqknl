import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";

// Panel içi "Yazı" sohbeti — OpenRouter üzerinden (varsayılan model: venice/uncensored).
// Kişisel kullanım; panel şifresi arkasında.
// API anahtarı: veritabanı (integrations.openrouter_api_key) > env (OPENROUTER_API_KEY).
// Anahtar DEPOYA asla yazılmaz; panelde "Yazı" sekmesinden değiştirilir.
export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_MODEL = "venice/uncensored";
const KEY_ROW = "openrouter_api_key";

let keyCache: { at: number; key: string } | null = null;

async function getOrKey(): Promise<string> {
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  if (keyCache && Date.now() - keyCache.at < 60_000) return keyCache.key;
  try {
    const rows = await db.select().from(integrations).where(eq(integrations.key, KEY_ROW));
    const v = (rows[0]?.value as { k?: string } | undefined)?.k?.trim();
    if (v) {
      keyCache = { at: Date.now(), key: v };
      return v;
    }
  } catch {
    /* DB erişimi yoksa env'ye düş */
  }
  return "";
}

type Msg = { role: "system" | "user" | "assistant"; content: string };

export async function POST(req: Request) {
  const orKey = await getOrKey();
  if (!orKey) {
    return NextResponse.json(
      { ok: false, error: "OpenRouter anahtarı tanımlı değil — Yazı sekmesindeki '🔑 API anahtarı' alanına ekle." },
      { status: 500 },
    );
  }

  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  const rawMsgs = Array.isArray(b.messages) ? (b.messages as unknown[]) : [];
  const messages: Msg[] = rawMsgs
    .filter((m): m is { role?: string; content: string } => Boolean(m) && typeof (m as { content?: unknown }).content === "string")
    .map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content.slice(0, 20_000),
    }))
    .slice(-40);

  if (typeof b.system === "string" && b.system.trim()) {
    messages.unshift({ role: "system", content: b.system.trim().slice(0, 4_000) });
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") {
    return NextResponse.json({ ok: false, error: "Son mesaj 'user' olmalı." }, { status: 400 });
  }

  const model = typeof b.model === "string" && b.model.trim() ? b.model.trim().slice(0, 120) : DEFAULT_MODEL;
  const temperature =
    typeof b.temperature === "number" && Number.isFinite(b.temperature) ? Math.min(Math.max(b.temperature, 0), 2) : 0.9;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${orKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, temperature }),
      signal: AbortSignal.timeout(110_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    if (!res.ok) {
      const msg = data?.error?.message || `OpenRouter hata ${res.status}`;
      const status = res.status === 401 ? 401 : res.status === 402 ? 402 : res.status === 429 ? 429 : 502;
      return NextResponse.json({ ok: false, error: String(msg).slice(0, 400) }, { status });
    }
    const content = data?.choices?.[0]?.message?.content ?? "";
    if (!content) {
      return NextResponse.json({ ok: false, error: "Boş yanıt geldi — tekrar dene." }, { status: 502 });
    }
    return NextResponse.json({ ok: true, content, model: data.model || model });
  } catch (e) {
    const reason =
      e instanceof Error ? (e.name === "TimeoutError" || e.name === "AbortError" ? "Süre doldu (110 sn) — tekrar dene." : e.message) : String(e);
    return NextResponse.json({ ok: false, error: String(reason).slice(0, 400) }, { status: 502 });
  }
}
