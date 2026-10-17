import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { downloadDriveFile, listDriveFolderFiles } from "@/lib/google-drive";
import { addYoutubeComment, listMyChannelVideos, loadYoutubeTokens, uploadShort, youtubeStatus } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request) {
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (secret && req.headers.get("x-mira-key") === secret) return true;
  return isMiraSessionCookie(req.headers.get("cookie"));
}

function normalizedTitle(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("tr-TR").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (body.confirm !== true) {
    return NextResponse.json({ ok: false, error: "Açık işlem onayı gerekli: confirm=true." }, { status: 400 });
  }

  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 30) : [];
  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  const publishAt = typeof body.publishAt === "string" ? body.publishAt.trim() : "";

  if (!/^(?:video_\d+|uzun_video_\d+)\.mp4$/i.test(fileName)) {
    return NextResponse.json({ ok: false, error: "Yalnızca Drive kataloğundaki video_N.mp4 veya uzun_video_N.mp4 dosyaları yüklenebilir." }, { status: 400 });
  }
  if (!title || title.length > 100) return NextResponse.json({ ok: false, error: "YouTube başlığı 1–100 karakter olmalı." }, { status: 400 });
  if (description.length > 4900) return NextResponse.json({ ok: false, error: "Açıklama 4.900 karakteri aşamaz." }, { status: 400 });
  if (!publishAt) return NextResponse.json({ ok: false, error: "Planlı yayın için publishAt ISO tarih-saat bilgisi gerekli." }, { status: 400 });
  const scheduledDate = new Date(publishAt);
  if (!Number.isFinite(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now() + 60_000) {
    return NextResponse.json({ ok: false, error: "publishAt geçerli ve en az 1 dakika ileride olmalı." }, { status: 400 });
  }

  const config = youtubeStatus();
  const tokens = await loadYoutubeTokens().catch(() => null);
  if (!config.configured || (!tokens && !process.env.YOUTUBE_REFRESH_TOKEN)) {
    return NextResponse.json({ ok: false, error: "YouTube OAuth bağlantısı hazır değil.", missingEnv: config.missing }, { status: 503 });
  }

  try {
    const [files, channel] = await Promise.all([listDriveFolderFiles(), listMyChannelVideos(500)]);
    const file = files.find((item) => item.name.toLocaleLowerCase("tr-TR") === fileName.toLocaleLowerCase("tr-TR"));
    if (!file) return NextResponse.json({ ok: false, error: `Drive klasöründe ${fileName} bulunamadı.` }, { status: 404 });
    if (file.mimeType !== "video/mp4") return NextResponse.json({ ok: false, error: `${fileName} MP4 video dosyası değil.` }, { status: 415 });

    const candidate = normalizedTitle(title);
    const existing = channel.videos.find((video) => normalizedTitle(video.title) === candidate);
    if (existing) {
      return NextResponse.json({
        ok: false,
        duplicate: true,
        error: "Aynı başlıkta bir video zaten kanalda var; olası tekrar yükleme engellendi.",
        existingVideo: existing,
      }, { status: 409 });
    }

    const downloaded = await downloadDriveFile(file.id);
    const expectedBytes = Number(file.size || 0);
    const actualBytes = downloaded.data.length;
    if (downloaded.mimeType !== "video/mp4" || actualBytes < 12 || downloaded.data.toString("ascii", 4, 8) !== "ftyp") {
      return NextResponse.json({ ok: false, uploaded: false, error: "Drive dosyası geçerli MP4 değil; yükleme durduruldu." }, { status: 415 });
    }
    if (expectedBytes <= 0 || actualBytes !== expectedBytes) {
      return NextResponse.json({
        ok: false,
        uploaded: false,
        error: "Drive indirmesi eksik veya boyut doğrulaması başarısız; YouTube yüklemesi durduruldu.",
        fileName,
        expectedBytes,
        actualBytes,
      }, { status: 422 });
    }

    const uploaded = await uploadShort({
      title,
      description,
      tags,
      privacyStatus: "private",
      publishAt: scheduledDate.toISOString(),
      video: downloaded.data,
    });

    let commentResult: { added: boolean; commentId?: string; error?: string } = { added: false, error: "Yorum metni verilmedi." };
    if (comment) {
      try {
        const result = await addYoutubeComment(uploaded.videoId, comment);
        commentResult = { added: true, commentId: result.commentId };
      } catch (error) {
        commentResult = { added: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) };
      }
    }

    return NextResponse.json({
      ok: true,
      uploaded: true,
      scheduled: true,
      fileName,
      videoId: uploaded.videoId,
      url: uploaded.url,
      privacyStatus: uploaded.privacyStatus,
      publishAt: scheduledDate.toISOString(),
      comment: commentResult,
      pinned: false,
      pinNote: "YouTube Data API yorum sabitlemeyi desteklemiyor; sabitleme YouTube Studio'dan yapılmalı.",
      note: "Yalnızca planlandı. Videonun yayınlandığı veya yorumun sabitlendiği iddia edilmiyor.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen YouTube yükleme hatası";
    return NextResponse.json({ ok: false, uploaded: false, error: message.slice(0, 600) }, { status: 502 });
  }
}
