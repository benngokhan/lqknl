import { NextResponse } from "next/server";
import { MIRA_ALLOW_PAID_TTS } from "@/lib/narration";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    configured: true,
    provider: "edge-tts",
    fallbackProvider: "google-tts",
    voice: process.env.EDGE_TTS_VOICE || "tr-TR-EmelNeural",
    model: "Microsoft Edge Neural TTS + Google TTS Fallback (100% Free)",
    needsApiKey: false,
    paidProviderEnabled: Boolean(MIRA_ALLOW_PAID_TTS),
  });
}
