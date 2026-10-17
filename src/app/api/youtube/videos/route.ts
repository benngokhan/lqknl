import { NextResponse } from "next/server";
import { listMyChannelVideos, loadYoutubeTokens, youtubeStatus } from "@/lib/youtube";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (secret && req.headers.get("x-mira-key") === secret) return true;
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });
  const config = youtubeStatus();
  const tokens = await loadYoutubeTokens().catch(() => null);
  if (!config.configured || (!tokens && !process.env.YOUTUBE_REFRESH_TOKEN)) {
    return NextResponse.json({ ok: false, error: "YouTube bağlantısı yapılandırılmamış.", missingEnv: config.missing }, { status: 503 });
  }
  const requestedLimit = Number(new URL(req.url).searchParams.get("limit") || 200);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, Math.floor(requestedLimit))) : 200;
  try {
    const result = await listMyChannelVideos(limit);
    return NextResponse.json({ ok: true, count: result.videos.length, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen YouTube hatası";
    return NextResponse.json({ ok: false, error: message.slice(0, 500) }, { status: 502 });
  }
}
