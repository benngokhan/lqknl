import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contentAssets, contentItems, operations, tasks } from "@/db/schema";
import { like } from "drizzle-orm";
import { parseDraftScript } from "@/lib/script-parse";
import { uploadShort, youtubeStatus, loadYoutubeTokens } from "@/lib/youtube";
import { sendPublishButton, sendTelegramMessage } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request) {
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (secret && req.headers.get("x-mira-key") === secret) return true;
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

function buildMetadata(title: string, topic: string | null, script: string | null) {
  const sections = script ? parseDraftScript(script) : {};
  const cleanTitle = title.trim().slice(0, 90);
  const descriptionParts = [
    `${cleanTitle} #Shorts`,
    sections["AÇIKLAMA"]?.split("\n").slice(0, 3).join(" ").trim(),
    topic && topic !== title ? `\nKonu: ${topic}` : "",
    "\nBilgi Dozu — kısa bilgi videoları",
  ].filter(Boolean);
  const tagsRaw = sections["ETİKETLER"] || "";
  const tags = tagsRaw
    .split(/[,\n]/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean)
    .slice(0, 10);
  if (!tags.includes("shorts")) tags.push("shorts");
  return { title: cleanTitle, description: descriptionParts.join("\n").slice(0, 4900), tags };
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "mira-youtube-uploader",
    usage: 'POST {"contentId": <id>, "privacy": "private|unlisted|public"} — içerik "ready" olmalı',
    note: "Audit'den geçmemiş Google projelerinde public videolar private kilitlenir (Google kuralı).",
  });
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const contentId = Number(body.contentId);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return NextResponse.json({ error: "contentId gerekli" }, { status: 400 });
  }
  const privacy = ["private", "unlisted", "public"].includes(body.privacy) ? body.privacy : undefined;

  const configStatus = youtubeStatus();
  if (!configStatus.configured) {
    return NextResponse.json({ ok: false, error: `YouTube OAuth eksik: ${configStatus.missing.join(", ")} — önce Railway env'e ekle` }, { status: 502 });
  }
  const hasTokens = (await loadYoutubeTokens().catch(() => null)) || process.env.YOUTUBE_REFRESH_TOKEN;
  if (!hasTokens) {
    return NextResponse.json({ ok: false, error: "Kanal bağlı değil: /api/youtube/auth ile Google hesabını bağla" }, { status: 502 });
  }

  try {
    // Güvenlik kapısı: yükleme için açık kullanıcı onayı kaydı zorunlu.
    const approvals = await db.select().from(operations)
      .where(and(eq(operations.action, "content_approved"), eq(operations.status, "success")))
      .orderBy(desc(operations.id)).limit(500);
    const hasUserApproval = approvals.some((op) => {
      const meta = op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {};
      return Number(meta.contentId) === contentId && meta.approvedByUser === true && meta.videoRequested === true;
    });
    if (!hasUserApproval) {
      return NextResponse.json({
        ok: false,
        error: "Yükleme durduruldu: bu içerik için kullanıcı onay kaydı bulunamadı.",
      }, { status: 403 });
    }

    // İçerik hazır mı?
    const [content] = await db.select().from(contentItems)
      .where(and(eq(contentItems.id, contentId), eq(contentItems.status, "ready"))).limit(1);
    if (!content) {
      return NextResponse.json({
        ok: false,
        error: "İçerik 'ready' durumda değil (üretim tamamlanmamış veya zaten yayınlanmış olabilir).",
      }, { status: 409 });
    }

    // Yalnızca gerçek MP4 video varlığını seç; görsel/ses dosyasını asla yükleme.
    const [asset] = await db.select().from(contentAssets)
      .where(and(
        eq(contentAssets.contentId, contentId),
        eq(contentAssets.kind, "video"),
        eq(contentAssets.mime, "video/mp4"),
      ))
      .orderBy(desc(contentAssets.id)).limit(1);
    if (!asset) {
      return NextResponse.json({ ok: false, error: "Bu içerik için video/mp4 varlığı bulunamadı." }, { status: 409 });
    }

    // Metadata: taslak senaryosundaki AÇIKLAMA/ETİKETLER varsa onlardan kur
    const draftOps = await db.select().from(operations)
      .where(and(eq(operations.action, "autonomous_content_draft"), eq(operations.status, "success")))
      .orderBy(desc(operations.id)).limit(200);
    const scriptMeta = draftOps
      .map((op) => (op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {}))
      .find((meta) => Number(meta.contentId) === content.id && typeof meta.script === "string");
    const script = typeof scriptMeta?.script === "string" ? scriptMeta.script : null;

    const metadata = buildMetadata(content.title, content.topic, script);
    const video = Buffer.from(asset.data, "base64");
    if (video.length < 12 || video.toString("ascii", 4, 8) !== "ftyp") {
      throw new Error("Video varlığı geçerli MP4 başlığı içermiyor; yükleme durduruldu.");
    }

    const result = await uploadShort({
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      privacyStatus: privacy,
      video,
    });

    const [updated] = await db.update(contentItems)
      .set({
        status: "published",
        externalId: result.videoId,
        url: result.url,
        publishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(contentItems.id, content.id)).returning();

    await db.update(tasks)
      .set({ status: "done", updatedAt: new Date() })
      .where(like(tasks.notes, `%"contentId":${content.id}%`));

    await db.insert(operations).values({
      action: "content_publish",
      summary: `YouTube'a yüklendi: ${content.title}`,
      status: "success",
      platform: "youtube",
      externalId: result.videoId,
      metadata: {
        contentId: content.id,
        assetId: asset.id,
        videoId: result.videoId,
        url: result.url,
        privacyStatus: result.privacyStatus,
        title: metadata.title,
        tags: metadata.tags,
      },
    });

    // YouTube başarıyla doğrulandıktan sonra video ve ara medya verilerini DB'den kaldır.
    // Yayın metaverisi ve YouTube URL'si content_items/operations içinde kalır.
    let mediaCleaned = false;
    try {
      await db.delete(contentAssets).where(eq(contentAssets.contentId, content.id));
      mediaCleaned = true;
      console.log(`[YouTube upload] içerik #${content.id}: tüm medya varlıkları silindi`);
    } catch (cleanupError) {
      console.error(`[YouTube upload] içerik #${content.id} yayımlandı ama medya temizliği başarısız:`, cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }

    let telegramNotice: { sent: boolean; reason?: string; error?: string } = { sent: false, reason: "not_private_upload" };
    if (result.privacyStatus === "private") {
      const sent = await sendPublishButton(content.id, content.title, result.url);
      telegramNotice = sent.sent ? { sent: true } : { sent: false, reason: sent.reason, error: sent.error };
    } else {
      const sent = await sendTelegramMessage("📺 YouTube yüklemesi tamamlandı.\n\n" + content.title + "\nGizlilik: " + result.privacyStatus + "\n" + result.url);
      telegramNotice = sent.sent ? { sent: true } : { sent: false, reason: sent.reason, error: sent.error };
    }

    return NextResponse.json({
      ok: true,
      published: true,
      contentId: content.id,
      videoId: result.videoId,
      url: result.url,
      privacyStatus: result.privacyStatus,
      mediaCleaned,
      telegramNotice,
      content: updated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[YouTube upload] failed:", message);
    await db.insert(operations).values({
      action: "content_publish",
      summary: `YouTube yüklemesi başarısız: #${contentId}`,
      status: "failed",
      platform: "youtube",
      metadata: { contentId, error: message.slice(0, 1500) },
    }).catch(() => {});
    return NextResponse.json({ ok: false, published: false, error: message.slice(0, 600) }, { status: 500 });
  }
}
