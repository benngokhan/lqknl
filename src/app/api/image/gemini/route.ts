import { NextResponse } from "next/server";

/**
 * Görsel Stüdyosu — Gemini 2.5 Flash Image (nano-banana)
 *  - prompt sadece        -> metinden görsel (text-to-image)
 *  + image_base64 (opsiy.) -> görselden görsel (image-to-image / düzenleme)
 * Yanıt: { ok, image_base64, mime_type, mode, model }
 */

const MODEL = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const ASPECT_HINTS: Record<string, string> = {
  "1:1": "kare (1:1) en-boy oranında",
  "16:9": "16:9 yatay (kapak/banner) en-boy oranında",
  "9:16": "9:16 dikey (shorts) en-boy oranında",
  "4:3": "4:3 en-boy oranında",
  "3:2": "3:2 en-boy oranında",
  "2:3": "2:3 dikey en-boy oranında",
};

type Part = { text?: string; inline_data?: { mime_type: string; data: string } };

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "GEMINI_API_KEY tanımlı değil — Railway env vars'a ekleyin." },
      { status: 500 },
    );
  }

  const body: unknown = await req.json().catch(() => ({}));
  const b = (body ?? {}) as Record<string, unknown>;
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ ok: false, error: "prompt gerekli" }, { status: 400 });
  }

  let imgB64 = typeof b.image_base64 === "string" ? b.image_base64.trim() : "";
  if (imgB64) imgB64 = imgB64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
  const imgMime =
    typeof b.mime_type === "string" && b.mime_type.startsWith("image/") ? b.mime_type : "image/png";
  const aspectKey = typeof b.aspect === "string" ? b.aspect : "";
  const aspectHint = ASPECT_HINTS[aspectKey] ?? "";

  const parts: Part[] = [];
  if (imgB64) parts.push({ inline_data: { mime_type: imgMime, data: imgB64 } });
  parts.push({
    text: aspectHint
      ? `${prompt}\n\n(Çıktıyı ${aspectHint} üret; çerçeve tamamen dolu, kenarlara boşluk/siyah bar ekleme.)`
      : prompt,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const raw = await res.text();
      let msg = `Gemini hata ${res.status}`;
      try {
        const j = JSON.parse(raw) as { error?: { message?: string } };
        if (j.error?.message) msg = j.error.message;
      } catch {
        msg = raw.slice(0, 300) || msg;
      }
      if (res.status === 429) msg = `Kota/dakika limiti dolmuş, 1-2 dk sonra tekrar dene. (${msg.slice(0, 200)})`;
      console.error("Mira Gemini image failed:", res.status, msg.slice(0, 400));
      return NextResponse.json({ ok: false, error: msg.slice(0, 600) }, { status: 502 });
    }

    const data = (await res.json()) as GeminiResponse;
    const cand = data.candidates?.[0];
    const out = cand?.content?.parts?.find((p) => p.inlineData && p.inlineData.data);
    const b64 = out?.inlineData?.data;
    const mime = out?.inlineData?.mimeType || "image/png";
    if (!b64) {
      const why = cand?.finishReason ? ` (neden: ${cand.finishReason})` : "";
      return NextResponse.json(
        { ok: false, error: `Görsel gelmedi${why} — prompt'u değiştirip tekrar dene.` },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      image_base64: b64,
      mime_type: mime,
      mode: imgB64 ? "img2img" : "txt2img",
      model: MODEL,
    });
  } catch (e) {
    const reason =
      e instanceof Error ? (e.name === "AbortError" ? "Süre doldu (150 sn) — tekrar dene." : e.message) : String(e);
    console.error("Mira Gemini image error:", reason.slice(0, 400));
    return NextResponse.json({ ok: false, error: reason.slice(0, 600) }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
