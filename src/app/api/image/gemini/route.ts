import { NextResponse } from "next/server";

/**
 * Görsel Stüdyosu — Gemini 2.5 Flash Image (nano-banana) + Pollinations yedek hattı
 *  - prompt sadece        -> metinden görsel (text-to-image): Gemini → kota doluyorsa Pollinations (anahtarsız)
 *  + image_base64 (opsiy.) -> görselden görsel (image-to-image / düzenleme): yalnız Gemini
 * Yanıt: { ok, image_base64, mime_type, mode, model, provider }
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

const POLLINATIONS_DIMS: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "4:3": [1152, 896],
  "3:2": [1216, 800],
  "2:3": [800, 1216],
};

type Part = { text?: string; inline_data?: { mime_type: string; data: string } };

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

class GeminiQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiQuotaError";
  }
}

async function geminiImage(
  key: string,
  parts: Part[],
): Promise<{ b64: string; mime: string }> {
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
      const isQuota = res.status === 429 || /quota|rate limit/i.test(msg);
      if (isQuota) throw new GeminiQuotaError(msg.slice(0, 400));
      throw new Error(msg.slice(0, 600));
    }

    const data = (await res.json()) as GeminiResponse;
    const cand = data.candidates?.[0];
    const out = cand?.content?.parts?.find((p) => p.inlineData && p.inlineData.data);
    const b64 = out?.inlineData?.data;
    const mime = out?.inlineData?.mimeType || "image/png";
    if (!b64) {
      const why = cand?.finishReason ? ` (neden: ${cand.finishReason})` : "";
      throw new Error(`Görsel gelmedi${why} — prompt'u değiştirip tekrar dene.`);
    }
    return { b64, mime };
  } finally {
    clearTimeout(timer);
  }
}

async function pollinationsImage(prompt: string, aspectKey: string): Promise<{ b64: string; mime: string }> {
  const [w, h] = POLLINATIONS_DIMS[aspectKey] ?? [1024, 1024];
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 800))}?width=${w}&height=${h}&seed=${seed}&nologo=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Pollinations yedek hat hatası ${res.status}`);
  const ct = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error("Pollinations boş/düşük görsel döndürdü — tekrar dene.");
  return { b64: buf.toString("base64"), mime: ct.startsWith("image/") ? ct.split(";")[0] : "image/jpeg" };
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
  const aspectKey = typeof b.aspect === "string" && ASPECT_HINTS[b.aspect] ? b.aspect : "1:1";
  const aspectHint = ASPECT_HINTS[aspectKey];

  const parts: Part[] = [];
  if (imgB64) parts.push({ inline_data: { mime_type: imgMime, data: imgB64 } });
  parts.push({
    text: aspectHint
      ? `${prompt}\n\n(Çıktıyı ${aspectHint} üret; çerçeve tamamen dolu, kenarlara boşluk/siyah bar ekleme.)`
      : prompt,
  });

  const mode = imgB64 ? "img2img" : "txt2img";
  const provider = b.provider === "gemini" || b.provider === "pollinations" ? b.provider : "auto";

  try {
    if (mode === "img2img") {
      // Görselden görsel yalnız Gemini'de var
      const { b64, mime } = await geminiImage(key, parts);
      return NextResponse.json({ ok: true, image_base64: b64, mime_type: mime, mode, model: MODEL, provider: "gemini" });
    }

    if (provider === "pollinations") {
      // Doğrudan yedek hat (Pollinations)
      const { b64, mime } = await pollinationsImage(prompt, aspectKey);
      return NextResponse.json({
        ok: true,
        image_base64: b64,
        mime_type: mime,
        mode,
        model: "pollinations",
        provider: "pollinations",
      });
    }

    // Metinden görsel: önce Gemini; provider=gemini ise yedeksiz, auto ise kota dolarsa Pollinations
    try {
      const { b64, mime } = await geminiImage(key, parts);
      return NextResponse.json({ ok: true, image_base64: b64, mime_type: mime, mode, model: MODEL, provider: "gemini" });
    } catch (e) {
      if (e instanceof GeminiQuotaError && provider !== "gemini") {
        console.warn("Gemini kotası dolu — Pollinations yedek hata geçiliyor.");
        const { b64, mime } = await pollinationsImage(prompt, aspectKey);
        return NextResponse.json({
          ok: true,
          image_base64: b64,
          mime_type: mime,
          mode,
          model: "pollinations",
          provider: "pollinations",
        });
      }
      throw e;
    }
  } catch (e) {
    const reason =
      e instanceof Error
        ? e.name === "AbortError"
          ? "Süre doldu (150 sn) — tekrar dene."
          : e.message
        : String(e);
    console.error("Mira image generation failed:", reason.slice(0, 400));
    return NextResponse.json({ ok: false, error: reason.slice(0, 600) }, { status: 502 });
  }
}
