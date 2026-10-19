import { NextResponse } from "next/server";
import { isMiraSessionCookie } from "@/lib/mira-auth";
import { driveStatus, loadDriveTokens, listDriveFolderFiles } from "@/lib/google-drive";
import { getMyChannel, loadYoutubeTokens, youtubeStatus } from "@/lib/youtube";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  return Boolean((secret && req.headers.get("x-mira-key") === secret) || isMiraSessionCookie(req.headers.get("cookie")));
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "Mira oturumu gerekli." }, { status: 401 });

  const checkedAt = new Date().toISOString();
  const drive = { status: "unknown" as "online" | "offline" | "unknown", detail: "" };
  const youtube = { status: "unknown" as "online" | "offline" | "unknown", detail: "" };

  try {
    const config = driveStatus();
    const tokens = await loadDriveTokens().catch(() => null);
    if (!config.configured || !tokens) throw new Error("Drive OAuth bağlantısı yapılandırılmamış.");
    const files = await listDriveFolderFiles();
    drive.status = "online";
    drive.detail = "Drive API yanıt verdi; klasör erişimi doğrulandı (" + files.length + " dosya).";
  } catch (error) {
    drive.status = "offline";
    drive.detail = error instanceof Error ? error.message.slice(0, 180) : "Drive bağlantısı doğrulanamadı.";
  }

  try {
    const config = youtubeStatus();
    const tokens = await loadYoutubeTokens().catch(() => null);
    if (!config.configured || (!tokens && !process.env.YOUTUBE_REFRESH_TOKEN)) throw new Error("YouTube OAuth bağlantısı yapılandırılmamış.");
    const channel = await getMyChannel();
    youtube.status = "online";
    youtube.detail = "YouTube API yanıt verdi; kanal doğrulandı: " + channel.channelTitle;
  } catch (error) {
    youtube.status = "offline";
    youtube.detail = error instanceof Error ? error.message.slice(0, 180) : "YouTube bağlantısı doğrulanamadı.";
  }

  return NextResponse.json({ ok: true, checkedAt, drive, youtube });
}
