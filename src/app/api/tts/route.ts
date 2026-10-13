import { NextResponse } from "next/server";
import { generateNarration, type MiraSolMode, type MiraTtsEmotion } from "@/lib/narration";

export const runtime = "nodejs";

function audioResponse(audio: Uint8Array, provider: string) {
  const body = new ArrayBuffer(audio.byteLength);
  new Uint8Array(body).set(audio);
  console.log("[TTS] Audio generated:", JSON.stringify({ provider, bytes: audio.length }));
  return new NextResponse(body as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.length),
      "Cache-Control": "no-store",
      "X-Mira-TTS-Provider": provider,
    },
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return NextResponse.json({ error: "Metin gerekli" }, { status: 400 });
    if (text.length > 5000) return NextResponse.json({ error: "Metin çok uzun" }, { status: 413 });

    const rawEmotion = body.emotion;
    const allowedEmotions: MiraTtsEmotion[] = ["happy", "surprised", "sad", "playful", "focused"];
    const emotion: MiraTtsEmotion = allowedEmotions.includes(rawEmotion) ? rawEmotion : "happy";
    const rawMode = body.solMode;
    const allowedModes: MiraSolMode[] = ["sweet", "flirty", "serious", "excited", "close"];
    const solMode: MiraSolMode = allowedModes.includes(rawMode) ? rawMode : "close";
    const narration = await generateNarration(text, { emotion, solMode });

    // format:"json" → ses + senkron altyazı + gerçek süre (içerik hattı için)
    if (body.format === "json") {
      return NextResponse.json({
        ok: true,
        provider: narration.provider,
        audioBase64: Buffer.from(narration.audio).toString("base64"),
        captions: narration.captions,
        durationSeconds: narration.durationSeconds,
      });
    }

    return audioResponse(narration.audio, narration.provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TTS] Request failed:", message);
    return NextResponse.json(
      { error: "Ses üretimi başarısız oldu: " + message.slice(0, 300) },
      { status: 502 },
    );
  }
}
