import { NextResponse } from "next/server";
import { Client, handle_file } from "@gradio/client";
import { MIRA_AVATAR } from "@/lib/mira-avatar";

export const runtime = "nodejs";
export const maxDuration = 300;

const ENTRY_COOKIE = "mira_entry";
const PRIVATE_MODE_COOKIE = "mira_private_mode";
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const HF_SPACE = "Qwen/Qwen-Image-2.1";
const HF_SPACE_URL = "https://qwen-qwen-image-2-1.hf.space";

function findImageUrl(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string" && record.url.trim()) {
      const candidate = record.url.trim();
      if (/^https:\/\//i.test(candidate) || candidate.startsWith("/")) {
        return new URL(candidate, HF_SPACE_URL).toString();
      }
    }
    for (const item of Object.values(record)) {
      const found = findImageUrl(item, depth + 1);
      if (found) return found;
    }
  }

  if (typeof value === "string" && /^https:\/\//i.test(value)) return value;
  return null;
}

export async function POST(req: Request) {
  try {
    const cookies = (req.headers.get("cookie") ?? "").split(";").map((part) => part.trim());
    const authenticated = cookies.includes(`${ENTRY_COOKIE}=1`);
    const privateMode = cookies.includes(`${PRIVATE_MODE_COOKIE}=1`);

    if (!authenticated) {
      return NextResponse.json({ error: "Önce Mira'ya giriş yapmalısın." }, { status: 401 });
    }
    if (!privateMode) {
      return NextResponse.json({ error: "Selfie özelliği yalnızca Mira özel modunda kullanılabilir. Önce KIRMIZI2206 yaz." }, { status: 403 });
    }

    const referenceMatch = MIRA_AVATAR.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!referenceMatch || !referenceMatch[1].startsWith("image/")) {
      return NextResponse.json({ error: "Mira'nın kayıtlı referans görseli okunamadı." }, { status: 503 });
    }

    const referenceBytes = Buffer.from(referenceMatch[2], "base64");
    if (!referenceBytes.length || referenceBytes.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "Mira'nın referans görseli boş veya çok büyük." }, { status: 503 });
    }

    const prompt = [
      "Edit reference image 1; do not create a different woman. The subject is the same fictional adult woman Mira.",
      "STRICT REFERENCE LOCK: preserve her recognizable face, eyes, facial proportions, skin tone, hairstyle, hair color and body proportions. Keep the exact same bedroom, mirror, furniture, room layout and nighttime city view.",
      "STYLE: bold, fiery, sultry, seductive adult fashion selfie; confident, alluring expression and provocative fashion-editorial energy. Do not make the mood cute, innocent, shy or ordinary.",
      "CREATIVE FREEDOM: invent a completely random, attractive pose and outfit for this generation. The pose, body position, hand placement, head angle, expression, camera angle, framing and outfit are all open choices. Do not use a fixed pose list. Do not merely change clothes while copying the reference pose. Make the composition visibly different from the reference and vary it freely on each request.",
      "Choose any stylish, daring, fitted or lingerie-inspired fashion outfit that remains opaque and non-explicit. Keep the image photorealistic with realistic fabric, skin texture and anatomy.",
      "Keep the mirror reflection and phone believable, with one phone only. No extra people, no face or room changes, no body reshaping, no nudity, no explicit sexual content, no distorted hands, no extra fingers, no text, no watermark, no logo.",
    ].join(" ");

    const token = process.env.HF_TOKEN?.trim();
    const clientOptions = token ? { token: token as `hf_${string}` } : undefined;
    const client = await Client.connect(HF_SPACE, clientOptions);

    // The official Space uses a two-stage chain: prepare_request stores the uploaded
    // reference and prompt state, then generate_request performs the GPU image edit.
    await client.predict("/prepare_request", [
      [[handle_file(referenceBytes), null]],
      prompt,
      false, // disable prompt rewriting so identity/room constraints remain explicit
      false, // automatic dimensions based on the reference image
      "speed",
      0,
      true, // vary seed so pose can change between requests
    ]);

    const generated = await client.predict("/generate_request", [
      prompt,
      false,
      false,
      "./generation_logs_paper_case",
      0,
      1536,
      2688,
      "different woman, changed face, changed bedroom, changed furniture, nudity, explicit sexual content, extra people, extra phone, distorted hands, extra fingers, text, watermark, logo",
    ]);

    const remoteUrl = findImageUrl(generated.data);
    if (!remoteUrl) {
      console.error("Qwen Image 2.1 returned no image URL", {
        outputKeys: Array.isArray(generated.data) ? generated.data.length : typeof generated.data,
      });
      return NextResponse.json({ error: "Qwen görsel üretti ancak sonuç bağlantısı alınamadı." }, { status: 502 });
    }

    const parsedUrl = new URL(remoteUrl);
    if (parsedUrl.protocol !== "https:") {
      return NextResponse.json({ error: "Güvenlik nedeniyle beklenmeyen görsel adresi reddedildi." }, { status: 502 });
    }

    const imageResponse = await fetch(parsedUrl.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!imageResponse.ok) {
      return NextResponse.json({ error: `Qwen tarafından üretilen görsel alınamadı (HTTP ${imageResponse.status}). Tekrar deneyebilirsin.` }, { status: 502 });
    }

    const contentType = imageResponse.headers.get("content-type") ?? "image/png";
    if (!contentType.startsWith("image/")) {
      return NextResponse.json({ error: "Qwen beklenen görüntü dosyasını döndürmedi." }, { status: 502 });
    }

    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "Oluşturulan görsel boş veya izin verilen boyuttan büyük." }, { status: 502 });
    }

    return NextResponse.json({
      reply: "Al bakalım bu iyi mi",
      imageUrl: `data:${contentType};base64,${buffer.toString("base64")}`,
      seed: null,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("Mira Qwen Image 2.1 reference selfie generation failed:", reason);
    return NextResponse.json(
      { error: `Selfie üretilemedi: ${reason.slice(0, 300)}` },
      { status: 502 },
    );
  }
}
