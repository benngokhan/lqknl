import { NextResponse } from "next/server";
import { generateTensorArtImageFromReference } from "@/lib/tensorart";
import { MIRA_AVATAR } from "@/lib/mira-avatar";

export const runtime = "nodejs";

const ENTRY_COOKIE = "mira_entry";
const PRIVATE_MODE_COOKIE = "mira_private_mode";
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

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

    const prompt = "Photorealistic spontaneous mirror selfie of Mira, a fictional adult woman. Use the uploaded reference image as the identity anchor: preserve the same recognizable face, eye shape and color, facial proportions, skin tone, and dark brown hair; do not replace her with a different person. Vertical portrait from head to upper thighs, relaxed confident slightly playful pose, cozy bedroom at night with warm bedside lighting, candid phone-camera quality, realistic skin texture and natural proportions. Change only the outfit and scene styling: elegant black satin camisole with a tasteful open black satin shirt, refined bold fashion, fully clothed, no nudity. One smartphone held in one hand, believable mirror reflection, natural other hand at her hip. No extra people, no duplicated phones, no distorted hands, no text, no watermark, no studio photoshoot.";
    const result = await generateTensorArtImageFromReference(prompt, referenceBytes, referenceMatch[1]);
    const first = Array.isArray(result.images) ? result.images[0] : null;
    const remoteUrl = first && typeof first.url === "string" ? first.url : "";
    if (!remoteUrl) {
      console.error("Mira Tensor.Art reference selfie returned no image URL");
      return NextResponse.json({ error: "Görsel üretildi ancak API görsel bağlantısını döndürmedi." }, { status: 502 });
    }

    const parsedUrl = new URL(remoteUrl);
    if (parsedUrl.protocol !== "https:") {
      return NextResponse.json({ error: "Güvenlik nedeniyle beklenmeyen görsel adresi reddedildi." }, { status: 502 });
    }

    const imageResponse = await fetch(parsedUrl.toString(), { cache: "no-store" });
    if (!imageResponse.ok) {
      return NextResponse.json({ error: `Üretilen görsel alınamadı (HTTP ${imageResponse.status}). Tekrar deneyebilirsin.` }, { status: 502 });
    }
    const contentType = imageResponse.headers.get("content-type") ?? "image/webp";
    if (!contentType.startsWith("image/")) {
      return NextResponse.json({ error: "Görsel servisi beklenen görüntü dosyasını döndürmedi." }, { status: 502 });
    }
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "Oluşturulan görsel boş veya izin verilen boyuttan büyük." }, { status: 502 });
    }

    const imageUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
    return NextResponse.json({
      reply: "Al bakalım bu iyi mi",
      imageUrl,
      seed: null,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("Mira Tensor.Art reference selfie generation failed:", reason);
    return NextResponse.json(
      { error: `Selfie üretilemedi: ${reason.slice(0, 300)}` },
      { status: 502 },
    );
  }
}
