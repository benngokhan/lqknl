import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const paidTtsAllowed = process.env.MIRA_ALLOW_PAID_TTS === "true";
  const elevenLabsConfigured = Boolean(
    paidTtsAllowed && process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID,
  );
  const elevenLabsModel = process.env.ELEVENLABS_MODEL_ID || process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

  return NextResponse.json({
    configured: true,
    provider: elevenLabsConfigured ? "elevenlabs" : "edge-tts",
    fallbackProvider: "edge-tts",
    voice: elevenLabsConfigured
      ? process.env.ELEVENLABS_VOICE_ID
      : process.env.EDGE_TTS_VOICE || "tr-TR-EmelNeural",
    model: elevenLabsConfigured
      ? elevenLabsModel
      : "Microsoft Edge Neural TTS (free)",
    needsApiKey: false,
    paidProviderEnabled: elevenLabsConfigured,
  });
}
