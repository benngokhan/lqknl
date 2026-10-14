import { generateTensorArtImage } from "./tensorart";
import type { RenderImage } from "./render-video";

/**
 * Görsel zinciri: Tensor.Art → Gemini Image → Pixabay stok fotoğrafı.
 * AI sağlayıcıları kota/parametre nedeniyle çalışmazsa, ana konuyla ilgili dikey fotoğraf
 * ile video üretimi devam edebilir. Pixabay yalnızca API anahtarı varsa kullanılır.
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
  if (typeof value === "string") return /^https?:\/\/\S+$/i.test(value) ? value : null;
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

const STOP_WORDS = new Set([
  "cinematic", "cinematicly", "photorealistic", "photoreal", "vertical", "image", "scene",
  "shot", "close", "up", "wide", "medium", "dark", "blue", "cold", "grade", "vignette",
  "film", "grain", "natural", "lighting", "dramatic", "realistic", "high", "quality",
  "detailed", "portrait", "background", "backgrounds", "with", "and", "the", "from",
  "that", "this", "into", "while", "under", "over", "showing", "shows", "featuring",
]);

function pixabayQuery(prompt: string): string {
  const subject = prompt.split(/[.;\n]/, 1)[0] || prompt;
  const words = subject
    .replace(/[^a-zA-Z0-9 -]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word.toLowerCase()));
  return [...new Set(words)].slice(0, 8).join(" ").slice(0, 100);
}

async function fromPixabay(prompt: string): Promise<GeneratedImage> {
  const key = process.env.PIXABAY_API_KEY?.trim();
  if (!key) throw new Error("PIXABAY_API_KEY tanımlı değil; stok görsel yedeği atlandı");
  const query = pixabayQuery(prompt);
  if (!query) throw new Error("Pixabay için konu anahtar kelimesi çıkarılamadı");
  const url = new URL("https://pixabay.com/api/");
  url.searchParams.set("key", key);
  url.searchParams.set("q", query);
  url.searchParams.set("image_type", "photo");
  url.searchParams.set("orientation", "vertical");
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("per_page", "10");
  url.searchParams.set("order", "popular");
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
  const data = await res.json().catch(() => null) as {
    totalHits?: number;
    hits?: { largeImageURL?: string; webformatURL?: string; imageWidth?: number; imageHeight?: number }[];
    error?: string;
  } | null;
  if (!res.ok) throw new Error(`Pixabay API HTTP ${res.status}: ${(data?.error || "istek reddedildi").slice(0, 160)}`);
  const hit = (data?.hits || [])
    .filter((item) => (item.imageHeight || 0) >= (item.imageWidth || 0))
    .sort((a, b) => (b.imageHeight || 0) - (a.imageHeight || 0))[0] || data?.hits?.[0];
  const imageUrl = hit?.largeImageURL || hit?.webformatURL;
  if (!imageUrl) throw new Error(`Pixabay ilgili görsel bulamadı (sorgu: ${query})`);
  return { ...(await downloadImageBytes(imageUrl)), provider: "pixabay-stock" };
}

export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const errors: string[] = [];
  for (const fn of [fromTensorArt, fromGeminiImage, fromPixabay]) {
    try {
      const image = await fn(prompt);
      console.info("[Görsel] sağlayıcı başarılı:", image.provider);
      return image;
    } catch (error) {
      const detail = errMessage(error).slice(0, 220);
      errors.push(`${fn.name}: ${detail}`);
      console.error(`[Görsel] ${fn.name} başarısız; zincir devam ediyor: ${detail}`);
    }
  }
  throw new Error(`Tüm görsel sağlayıcıları başarısız oldu → ${errors.join(" | ")}`);
}
