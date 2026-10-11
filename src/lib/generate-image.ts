import { generateTensorArtImage } from "./tensorart";
import type { RenderImage } from "./render-video";

/**
 * Görsel üretim yedek zinciri: Tensor.Art → Gemini 2.5 Flash Image → Pollinations.
 * Bir sağlayıcı patlarsa (auth hatası, kota, yavaşlık...) üretim hattı durmasın;
 * doğal dil senaryo promptları tüm sağlayıcılarda tek metrolojiyle (576x1024 dikey) üretilir.
 */
export type GeneratedImage = RenderImage & { provider: string };

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function downloadImageBytes(url: string, timeoutMs = 75_000): Promise<RenderImage> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "MiraContentPipeline/1.0" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Görsel indirilemedi HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error(`Görsel beklenirken ${type || "bilinmeyen tip"} geldi`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error("Görsel boş veya çok büyük");
  const extension = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  return { bytes: buffer, extension };
}

function firstImageUrl(value: unknown): string | null {
  if (typeof value === "string") {
    return /^https?:\/\/\S+$/i.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstImageUrl(item);
      if (url) return url;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const url = firstImageUrl(item);
      if (url) return url;
    }
  }
  return null;
}

async function fromTensorArt(prompt: string): Promise<GeneratedImage> {
  const result = await generateTensorArtImage(prompt);
  const url = firstImageUrl(result);
  if (!url) throw new Error("Tensor.Art görsel URL'si döndürmedi");
  return { ...(await downloadImageBytes(url)), provider: "tensorart" };
}

async function fromGeminiImage(prompt: string): Promise<GeneratedImage> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY tanımlı değil; sağlayıcı atlandı");
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Vertical 9:16 cinematic image: ${prompt}` }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16" } },
    }),
    signal: AbortSignal.timeout(90_000),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
  } | null;
  if (!res.ok) throw new Error(`Gemini image HTTP ${res.status}: ${(data?.error?.message || "istek reddedildi").slice(0, 200)}`);
  if (data?.promptFeedback?.blockReason) throw new Error(`Gemini prompt engellendi: ${data.promptFeedback.blockReason}`);
  const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error("Gemini görsel verisi döndürmedi");
  const mime = part.inlineData.mimeType || "image/png";
  const extension = mime.includes("webp") ? "webp" : mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
  const bytes = Buffer.from(part.inlineData.data, "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Gemini görseli boş veya çok büyük");
  return { bytes, extension, provider: "gemini-2.5-flash-image" };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Pollinations anonim kademesi hız aşımını HTTP 402/500 olarak yansıtıyor (testle doğrulandı):
// art arda istekler kısa kovada reddediliyor. Üst üste çağrı çıkaran pipeline için
// modül düzeyinde minimum çağrı aralığı + rate-limit yanıtında soğuma tekrarı.
let lastPollinationsCall = 0;

async function fromPollinations(prompt: string): Promise<GeneratedImage> {
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const encoded = encodeURIComponent(prompt.slice(0, 800));
  // Not: safe=true parametresi Pollinations'da 402'ye düşüyor (premium'a taşınmış); güvenlik
  // LLM prompt şablonunun "safe for work" şartıyla sağlanıyor.
  const url = [
    "https://image.pollinations.ai/prompt/",
    `${encoded}?width=576&height=1024&seed=${seed}&nologo=true&model=flux`,
  ].join("");

  let lastError = "bilinmeyen hata";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const waitMs = 25_000 - (Date.now() - lastPollinationsCall);
    if (lastPollinationsCall > 0 && waitMs > 0) await sleep(waitMs);
    lastPollinationsCall = Date.now();
    try {
      return { ...(await downloadImageBytes(url)), provider: "pollinations" };
    } catch (error) {
      lastError = errMessage(error);
      if (/HTTP (402|429|5\d\d)/.test(lastError) && attempt < 5) {
        await sleep(45_000); // anonim kova soğuması
        continue;
      }
      throw new Error(lastError);
    }
  }
  throw new Error(lastError);
}

export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const errors: string[] = [];
  for (const fn of [fromTensorArt, fromGeminiImage, fromPollinations]) {
    try {
      return await fn(prompt);
    } catch (error) {
      errors.push(`${fn.name}: ${errMessage(error).slice(0, 200)}`);
    }
  }
  throw new Error(`3 görsel sağlayıcısı da başarısız oldu → ${errors.join(" | ")}`);
}
