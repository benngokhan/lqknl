import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";

// Panel içi "Yazı" sohbeti — ÜCRETSIZ 3 HAT:
//  1) openrouter   : kullanıcının OpenRouter anahtarı + :free modeller (varsayılan)
//  2) gemini       : GEMINI_API_KEY ile ücretsiz katman
//  3) pollinations : anahtarsız
// Kişisel kullanım; panel şifresi arkasında. OpenRouter anahtarı DB'de (integrations).
export const runtime = "nodejs";
export const maxDuration = 120;

const KEY_ROW = "openrouter_api_key";
const DEFAULTS: Record<string, string> = {
  openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free",
  gemini: "gemini-2.5-flash",
  pollinations: "openai",
};

let keyCache: { at: number; key: string } | null = null;

async function getOrKey(): Promise<string> {
  // ÖNCELİK: DB (panel içi yönetim) > env (yedek)
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
  return process.env.OPENROUTER_API_KEY?.trim() || "";
}

type Msg = { role: "system" | "user" | "assistant"; content: string };

async function callOpenRouter(orKey: string, model: string, messages: Msg[]): Promise<{ content: string; model: string }> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${orKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages }),
    signal: AbortSignal.timeout(110_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!res.ok) {
    const msg = data?.error?.message || `OpenRouter hata ${res.status}`;
    throw new Error(String(msg).slice(0, 400));
  }
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("Boş yanıt geldi — tekrar dene.");
  return { content, model: data.model || model };
}

async function callGemini(model: string, messages: Msg[]): Promise<{ content: string; model: string }> {
  const gkey = process.env.GEMINI_API_KEY?.trim();
  if (!gkey) throw new Error("GEMINI_API_KEY tanımlı değil — başka hatta dene.");
  const system = messages.find((m) => m.role === "system")?.content;
  const rest = messages.filter((m) => m.role !== "system");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": gkey, "content-type": "application/json" },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: rest.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  };
  if (!res.ok) {
    const msg = data?.error?.message || `Gemini hata ${res.status}`;
    if (res.status === 429) {
      throw new Error("Gemini ücretsiz kotası bugün doldu — başka bir hatta geç veya yarın dene.");
    }
    throw new Error(String(msg).slice(0, 400));
  }
  const cand = data.candidates?.[0];
  const content = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!content) {
    if (cand?.finishReason === "SAFETY" || cand?.finishReason === "BLOCKED") {
      throw new Error("Gemini güvenlik filtresi prompt'u blokladı — farklı ifade dene veya başka hatta geç.");
    }
    throw new Error("Boş yanıt geldi — tekrar dene.");
  }
  return { content, model };
}

async function callPollinations(model: string, messages: Msg[]): Promise<{ content: string; model: string }> {
  const rest = messages.filter((m) => m.role !== "system");
  const res = await fetch("https://text.pollinations.ai/openai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: rest.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) throw new Error(`Pollinations text hata ${res.status}`);
  if (ct.includes("application/json")) {
    const data = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error("Boş yanıt geldi — tekrar dene.");
    return { content, model };
  }
  // Bazı durumlar ham metin döner
  const text = (await res.text()).trim();
  if (!text) throw new Error("Boş yanıt geldi — tekrar dene.");
  return { content: text, model };
}

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  const provider = b.provider === "gemini" || b.provider === "pollinations" ? (b.provider as string) : "openrouter";

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

  const model =
    typeof b.model === "string" && b.model.trim() ? b.model.trim().slice(0, 120) : DEFAULTS[provider];

  try {
    let out: { content: string; model: string };
    if (provider === "gemini") {
      out = await callGemini(model, messages);
    } else if (provider === "pollinations") {
      out = await callPollinations(model, messages);
    } else {
      const orKey = await getOrKey();
      if (!orKey) {
        return NextResponse.json(
          { ok: false, error: "OpenRouter anahtarı tanımlı değil — Yazı sekmesindeki '🔑 API anahtarı' alanına ekle ya da Gemini/Yedek hattını kullan." },
          { status: 500 },
        );
      }
      try {
        out = await callOpenRouter(orKey, model, messages);
      } catch (e) {
        // 4xx/5xx'leri Türkçe hata mesajıyla yukarı taşı
        throw e;
      }
    }
    return NextResponse.json({ ok: true, content: out.content, model: out.model, provider });
  } catch (e) {
    const reason =
      e instanceof Error
        ? e.name === "TimeoutError" || e.name === "AbortError"
          ? "Süre doldu — tekrar dene."
          : e.message
        : String(e);
    const status = /429|kota|rate/i.test(reason) ? 429 : 502;
    return NextResponse.json({ ok: false, error: String(reason).slice(0, 600) }, { status });
  }
}
