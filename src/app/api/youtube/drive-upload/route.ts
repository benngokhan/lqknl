import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { youtubeUploadJobs } from "@/db/schema";
import { downloadDriveFile, listDriveFolderFiles } from "@/lib/google-drive";
import { readDriveSpreadsheetMetadata } from "@/lib/drive-video-xlsx";
import { addYoutubeComment, listMyChannelVideos, loadYoutubeTokens, uploadShort, verifyYoutubeVideo, youtubeStatus } from "@/lib/youtube";
import { sendTelegramMessage } from "@/lib/telegram";

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
  const requestedTitle = typeof body.title === "string" ? body.title.trim() : "";
  const requestedDescription = typeof body.description === "string" ? body.description.trim() : "";
  const requestedTags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean).slice(0, 30) : undefined;
  const requestedComment = typeof body.comment === "string" ? body.comment.trim() : undefined;
  const publishNow = body.publishNow === true;
  const publishAt = typeof body.publishAt === "string" ? body.publishAt.trim() : "";

  if (!/^(?:video_\d+|uzun_video_\d+)\.mp4$/i.test(fileName)) {
    return NextResponse.json({ ok: false, error: "Yalnızca Drive kataloğundaki video_N.mp4 veya uzun_video_N.mp4 dosyaları yüklenebilir." }, { status: 400 });
  }
  if (requestedTitle.length > 100) return NextResponse.json({ ok: false, error: "YouTube başlığı 100 karakteri aşamaz." }, { status: 400 });
  if (requestedDescription.length > 4900) return NextResponse.json({ ok: false, error: "Açıklama 4.900 karakteri aşamaz." }, { status: 400 });
  let scheduledDate = new Date();
  if (!publishNow) {
    if (!publishAt) return NextResponse.json({ ok: false, error: "Planlı yayın için publishAt ISO tarih-saat bilgisi gerekli. Hemen yayımlamak için publishNow=true gönder." }, { status: 400 });
    scheduledDate = new Date(publishAt);
    if (!Number.isFinite(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now() + 60_000) {
      return NextResponse.json({ ok: false, error: "publishAt geçerli ve en az 1 dakika ileride olmalı." }, { status: 400 });
    }
  }

  const config = youtubeStatus();
  const tokens = await loadYoutubeTokens().catch(() => null);
  if (!config.configured || (!tokens && !process.env.YOUTUBE_REFRESH_TOKEN)) {
    return NextResponse.json({ ok: false, error: "YouTube OAuth bağlantısı hazır değil.", missingEnv: config.missing }, { status: 503 });
  }

  let activeJobId: number | null = null;
  let sessionPersisted = false;

  try {
    const [files, channel] = await Promise.all([listDriveFolderFiles(), listMyChannelVideos(500)]);
    const matchingFiles = files.filter((item) => item.name.toLocaleLowerCase("tr-TR") === fileName.toLocaleLowerCase("tr-TR"));
    if (!matchingFiles.length) return NextResponse.json({ ok: false, error: `Drive klasöründe ${fileName} bulunamadı.` }, { status: 404 });
    if (matchingFiles.length > 1) return NextResponse.json({ ok: false, error: `Drive klasöründe ${fileName} adlı birden fazla dosya var; yanlış dosya seçimini önlemek için yükleme durduruldu.` }, { status: 409 });
    const file = matchingFiles[0];
    if (file.mimeType !== "video/mp4") return NextResponse.json({ ok: false, error: `${fileName} MP4 video dosyası değil.` }, { status: 415 });

    const metadataFiles = files.filter((item) => item.name.toLocaleLowerCase("tr-TR") === "baslik.xlsx");
    if (metadataFiles.length !== 1) {
      return NextResponse.json({
        ok: false,
        error: metadataFiles.length
          ? "Drive klasöründe birden fazla baslik.xlsx dosyası var; metaveri belirsiz."
          : "Drive klasöründe baslik.xlsx bulunamadı.",
      }, { status: metadataFiles.length ? 409 : 404 });
    }

    let driveMetadata: ReturnType<typeof readDriveSpreadsheetMetadata>;
    try {
      const metadataFile = await downloadDriveFile(metadataFiles[0].id);
      driveMetadata = readDriveSpreadsheetMetadata(metadataFile.data, fileName);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "baslik.xlsx okunamadı";
      return NextResponse.json({ ok: false, error: `baslik.xlsx metaverisi geçersiz: ${detail}` }, { status: 422 });
    }

    // Explicit request fields override the matching Dosya Adı row in Drive/baslik.xlsx.
    let title = requestedTitle || driveMetadata.title;
    let description = requestedDescription || driveMetadata.description;
    let tags = requestedTags ?? driveMetadata.tags;
    let comment = requestedComment ?? driveMetadata.pinnedComment;

    if (!title || title.length > 100) {
      return NextResponse.json({ ok: false, error: "Başlık istekte veya baslik.xlsx içindeki eşleşen satırda bulunmalı ve 1–100 karakter olmalı." }, { status: 400 });
    }
    if (description.length > 4900) return NextResponse.json({ ok: false, error: "Açıklama 4.900 karakteri aşamaz." }, { status: 400 });
    if (tags.some((tag) => tag.length > 100) || tags.join(",").length > 500) {
      return NextResponse.json({ ok: false, error: "Etiket sınırları aşılıyor: her etiket en fazla 100, ayraçlarla toplam 500 karakter olabilir." }, { status: 400 });
    }

    if (!comment) {
      return NextResponse.json({ ok: false, error: "baslik.xlsx içindeki Sabit Yorum boş; yorum eklenemeyeceği için video yüklemesi başlatılmadı." }, { status: 422 });
    }

    const [existingJob] = await db.select().from(youtubeUploadJobs)
      .where(eq(youtubeUploadJobs.driveFileId, file.id)).limit(1);

    // A job/session created for scheduled mode must never be reused for immediate-public mode (or vice versa).
    const existingSavedMetadata = existingJob?.metadata && typeof existingJob.metadata === "object"
      ? existingJob.metadata as Record<string, unknown>
      : {};
    const existingPublishNow = existingSavedMetadata.publishNow === true;
    if (existingJob && existingPublishNow !== publishNow) {
      return NextResponse.json({ ok: false, needsReview: true, error: "Bu Drive dosyasının kayıtlı işi farklı bir yayın modunda. Yinelenen yüklemeyi önlemek için otomatik geçiş durduruldu; önce mevcut YouTube/iş durumu kontrol edilmeli." }, { status: 409 });
    }

    // If a resumable session already exists, its initial metadata is immutable.
    // Reuse the exact metadata and schedule saved with that session, not a changed request body.
    let effectiveScheduledDate = scheduledDate;
    if (existingJob?.uploadSessionUrl) {
      const saved = existingSavedMetadata;
      title = existingJob.title;
      if (typeof saved.description === "string") description = saved.description;
      if (Array.isArray(saved.tags)) tags = saved.tags.filter((tag): tag is string => typeof tag === "string");
      if (typeof saved.comment === "string") comment = saved.comment;
      if (!publishNow && existingJob.publishAt) effectiveScheduledDate = existingJob.publishAt;
    }

    const candidate = normalizedTitle(title);
    const existing = channel.videos.find((video) => normalizedTitle(video.title) === candidate);

    const successResponse = (videoId: string, url: string, reconciled = false, publishAtValue: Date | null = (publishNow ? null : effectiveScheduledDate)) => NextResponse.json({
      ok: true,
      uploaded: false,
      alreadyUploaded: true,
      duplicate: true,
      reconciled,
      verified: true,
      scheduled: !publishNow,
      fileName,
      videoId,
      url,
      privacyStatus: publishNow ? "public" : "private",
      publishAt: publishAtValue?.toISOString() ?? null,
      note: reconciled
        ? "Önceki yükleme yanıtı kaybolmuş olabilir; mevcut YouTube videosu Drive dosyasının işiyle eşleştirildi."
        : "Bu Drive dosyası daha önce başarıyla yüklenmiş.",
    });

    if (existingJob?.status === "completed") {
      if (existingJob.youtubeVideoId && existingJob.youtubeUrl) {
        return successResponse(existingJob.youtubeVideoId, existingJob.youtubeUrl, false, publishNow ? null : (existingJob.publishAt || effectiveScheduledDate));
      }
      return NextResponse.json({
        ok: false,
        duplicate: true,
        error: "Bu Drive dosyasının işi tamamlandı olarak kayıtlı ancak YouTube video kimliği eksik; otomatik tekrar yükleme engellendi.",
      }, { status: 409 });
    }

    if (existing) {
      // Reconcile only after verifying the actual YouTube resource against the intended metadata.
      if (existingJob) {
        try {
          await verifyYoutubeVideo(existing.videoId, {
            title,
            description,
            tags,
            privacyStatus: publishNow ? "public" : "private",
            ...(publishNow ? {} : { publishAt: effectiveScheduledDate.toISOString() }),
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return NextResponse.json({
            ok: false,
            needsReview: true,
            error: "Aynı başlıklı video bulundu ancak kaynak dosyayla eşleştiği metaveri doğrulamasıyla kanıtlanamadı: " + detail.slice(0, 400),
          }, { status: 409 });
        }
        const now = new Date();
        await db.update(youtubeUploadJobs).set({
          status: "completed",
          youtubeVideoId: existing.videoId,
          youtubeUrl: existing.url,
          uploadSessionUrl: null,
          leaseUntil: null,
          lastError: null,
          updatedAt: now,
          completedAt: existingJob.completedAt || now,
        }).where(eq(youtubeUploadJobs.id, existingJob.id));
        return successResponse(existing.videoId, existing.url, true, publishNow ? null : (existingJob.publishAt || effectiveScheduledDate));
      }
      return NextResponse.json({
        ok: false,
        duplicate: true,
        error: "Aynı başlıkta bir video zaten kanalda var; yanlışlıkla ikinci video oluşturulmaması için yükleme engellendi.",
        existingVideo: existing,
      }, { status: 409 });
    }

    if (existingJob?.lastError?.includes("session expired or no longer exists")) {
      return NextResponse.json({
        ok: false,
        needsReview: true,
        error: "Önceki YouTube yükleme oturumu sona ermiş. Yinelenen video riskini önlemek için yeni oturum otomatik başlatılmadı; önce kanaldaki video durumu uzlaştırılmalı.",
        fileName,
      }, { status: 409 });
    }

    if (existingJob?.status === "uploading" && existingJob.leaseUntil && existingJob.leaseUntil.getTime() > Date.now()) {
      return NextResponse.json({
        ok: false,
        inProgress: true,
        error: "Bu Drive dosyası için başka bir yükleme işlemi hâlen çalışıyor.",
        fileName,
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

    const contentHash = createHash("sha256").update(downloaded.data).digest("hex");
    const existingMetadata = existingJob?.metadata && typeof existingJob.metadata === "object"
      ? existingJob.metadata as Record<string, unknown>
      : {};
    if (existingJob?.uploadSessionUrl && typeof existingMetadata.contentHash === "string" &&
        existingMetadata.contentHash !== contentHash) {
      const message = "Google Drive dosyasının içeriği önceki yükleme oturumundan sonra değişmiş. Aynı oturuma farklı video baytları gönderilmedi.";
      await db.update(youtubeUploadJobs).set({
        status: "needs_review",
        lastError: message,
        leaseUntil: null,
        updatedAt: new Date(),
      }).where(eq(youtubeUploadJobs.id, existingJob.id));
      return NextResponse.json({ ok: false, needsReview: true, error: message, fileName }, { status: 409 });
    }

    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 10 * 60 * 1000);
    let uploadSessionUrl: string | undefined;

    if (existingJob) {
      const [claimed] = await db.update(youtubeUploadJobs).set({
        status: "uploading",
        title,
        publishAt: publishNow ? null : effectiveScheduledDate,
        attempts: existingJob.attempts + 1,
        leaseUntil,
        lastError: null,
        metadata: { tags, description, comment, hasComment: Boolean(comment), publishNow, contentHash, fileSize: actualBytes, modifiedTime: file.modifiedTime || null, source: "google_drive" },
        updatedAt: now,
      }).where(and(
        eq(youtubeUploadJobs.id, existingJob.id),
        or(
          ne(youtubeUploadJobs.status, "uploading"),
          isNull(youtubeUploadJobs.leaseUntil),
          lt(youtubeUploadJobs.leaseUntil, now),
        ),
      )).returning();

      if (!claimed) {
        return NextResponse.json({ ok: false, inProgress: true, error: "Bu Drive dosyası başka bir istek tarafından sahiplenildi; yinelenen yükleme engellendi." }, { status: 409 });
      }
      activeJobId = claimed.id;
      uploadSessionUrl = claimed.uploadSessionUrl || undefined;
      sessionPersisted = Boolean(uploadSessionUrl);
    } else {
      const [created] = await db.insert(youtubeUploadJobs).values({
        driveFileId: file.id,
        driveFileName: fileName,
        title,
        status: "uploading",
        attempts: 1,
        publishAt: publishNow ? null : effectiveScheduledDate,
        leaseUntil,
        metadata: { tags, description, comment, hasComment: Boolean(comment), publishNow, contentHash, fileSize: actualBytes, modifiedTime: file.modifiedTime || null, source: "google_drive" },
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing({ target: youtubeUploadJobs.driveFileId }).returning();

      if (!created) {
        return NextResponse.json({ ok: false, inProgress: true, error: "Bu Drive dosyası için başka bir istek yükleme işini başlattı; ikinci yükleme engellendi." }, { status: 409 });
      }
      activeJobId = created.id;
    }

    const uploaded = await uploadShort({
      title,
      description,
      tags,
      privacyStatus: publishNow ? "public" : "private",
      ...(!publishNow ? { publishAt: effectiveScheduledDate.toISOString() } : {}),
      video: downloaded.data,
      ...(uploadSessionUrl ? { uploadSessionUrl } : {}),
      onUploadSession: async (sessionUrl) => {
        if (activeJobId === null) throw new Error("Upload job ID is missing; cannot safely persist the YouTube session.");
        await db.update(youtubeUploadJobs).set({
          uploadSessionUrl: sessionUrl,
          updatedAt: new Date(),
          leaseUntil: new Date(Date.now() + 10 * 60 * 1000),
        }).where(eq(youtubeUploadJobs.id, activeJobId));
        sessionPersisted = true;
      },
    });

    await verifyYoutubeVideo(uploaded.videoId, {
      title,
      description,
      tags,
      privacyStatus: publishNow ? "public" : "private",
      ...(publishNow ? {} : { publishAt: effectiveScheduledDate.toISOString() }),
    });

    if (activeJobId !== null) {
      const completedAt = new Date();
      await db.update(youtubeUploadJobs).set({
        status: "completed",
        youtubeVideoId: uploaded.videoId,
        youtubeUrl: uploaded.url,
        uploadSessionUrl: null,
        leaseUntil: null,
        lastError: null,
        updatedAt: completedAt,
        completedAt,
      }).where(eq(youtubeUploadJobs.id, activeJobId));
      sessionPersisted = false;
    }

    let commentResult: { added: boolean; commentId?: string; error?: string } = { added: false, error: "Yorum metni verilmedi." };
    let telegramNotification: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "Bildirim henüz gönderilmedi." };
    if (comment) {
      try {
        const result = await addYoutubeComment(uploaded.videoId, comment);
        commentResult = { added: true, commentId: result.commentId };
        // Notify only after YouTube confirms that the comment was actually created.
        const notice = await sendTelegramMessage(
          `🚀 YOUTUBE SHORTS CANLI YAYINDA! 🎬\n📦 Dosya: ${fileName}\n✅ Durum: Herkese Açık (Public)\n💬 Yorum Eklendi! (Studio'dan sabitlemeyi unutma)\n🔗 İzle & Sabitle: https://www.youtube.com/shorts/${uploaded.videoId}`,
        );
        telegramNotification = notice.sent
          ? { sent: true }
          : { sent: false, reason: notice.reason, error: notice.error };
      } catch (error) {
        commentResult = { added: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) };
        const notice = await sendTelegramMessage(
          `⚠️ Video yüklendi${publishNow ? " ve herkese açık yayımlandı" : " ve planlandı"} ancak otomatik yorum atılamadı.\n\nVideo: ${title}\nDosya: ${fileName}\nYouTube: ${uploaded.url}\nHata: ${commentResult.error || "Bilinmeyen hata"}`,
        );
        telegramNotification = notice.sent
          ? { sent: true }
          : { sent: false, reason: notice.reason, error: notice.error };
      }
    } else {
      const notice = await sendTelegramMessage(
        `⚠️ Video ${publishNow ? "herkese açık yayımlandı" : "yüklendi ve planlandı"} ancak baslik.xlsx içinde yorum metni bulunamadı.\n\nVideo: ${title}\nDosya: ${fileName}\nYouTube: ${uploaded.url}`,
      );
      telegramNotification = notice.sent
        ? { sent: true }
        : { sent: false, reason: notice.reason, error: notice.error };
    }

    return NextResponse.json({
      ok: true,
      uploaded: true,
      verified: true,
      scheduled: !publishNow,
      fileName,
      videoId: uploaded.videoId,
      url: uploaded.url,
      privacyStatus: uploaded.privacyStatus,
      publishAt: publishNow ? null : effectiveScheduledDate.toISOString(),
      comment: commentResult,
      telegramNotification,
      pinned: false,
      pinNote: "YouTube Data API yorum sabitlemeyi desteklemiyor; sabitleme YouTube Studio'dan yapılmalı.",
      note: publishNow ? "Video herkese açık olarak yüklendi ve yayın durumu doğrulandı. Yorum sabitleme YouTube Studio üzerinden yapılmalı." : "Yalnızca planlandı. Videonun yayınlandığı veya yorumun sabitlendiği iddia edilmiyor.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen YouTube yükleme hatası";
    if (activeJobId !== null) {
      await db.update(youtubeUploadJobs).set({
        status: sessionPersisted ? "needs_review" : "failed",
        lastError: message.slice(0, 1500),
        leaseUntil: null,
        updatedAt: new Date(),
      }).where(eq(youtubeUploadJobs.id, activeJobId)).catch(() => {});
    }
    return NextResponse.json({
      ok: false,
      uploaded: false,
      needsReview: sessionPersisted,
      error: message.slice(0, 600),
    }, { status: 502 });
  }
}
