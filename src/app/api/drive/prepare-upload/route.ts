import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { contentAssets, contentItems, operations } from "@/db/schema";
import { downloadDriveFile, listDriveFolderFiles } from "@/lib/google-drive";
import { readDriveVideoMetadata } from "@/lib/drive-video-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return true;
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const fileId = typeof body.fileId === "string" ? body.fileId.trim() : "";
  const videoNumber = Number(body.videoNumber);
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(fileId) || !Number.isInteger(videoNumber) || videoNumber < 1 || videoNumber > 999) {
    return NextResponse.json({ ok: false, error: "Geçerli fileId ve videoNumber gerekli." }, { status: 400 });
  }

  try {
    const files = await listDriveFolderFiles();
    const driveFile = files.find((file) => file.id === fileId);
    if (!driveFile) return NextResponse.json({ ok: false, error: "Dosya Mira'nın bağlı Drive klasöründe bulunamadı." }, { status: 404 });
    if (driveFile.name.toLocaleLowerCase("tr-TR") !== `video_${videoNumber}.mp4`) {
      return NextResponse.json({ ok: false, error: `VIDEO ${videoNumber} için video_${videoNumber}.mp4 dosyası gerekli.` }, { status: 400 });
    }
    const existingOps = await db.select().from(operations)
      .where(eq(operations.action, "google_drive_video_import"))
      .orderBy(desc(operations.id)).limit(200);
    const existing = existingOps.find((op) => {
      const meta = op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {};
      return meta.driveFileId === fileId && op.status === "success";
    });
    if (existing) {
      const meta = existing.metadata && typeof existing.metadata === "object" ? existing.metadata as Record<string, unknown> : {};
      return NextResponse.json({ ok: true, alreadyImported: true, contentId: Number(meta.contentId), title: existing.summary });
    }

    const catalog = files.find((file) => file.name.toLocaleLowerCase("tr-TR") === "baslik.md");
    if (!catalog) return NextResponse.json({ ok: false, error: "Drive klasöründe baslik.md bulunamadı." }, { status: 404 });
    const [markdownFile, video] = await Promise.all([downloadDriveFile(catalog.id), downloadDriveFile(fileId)]);
    if (!/^video\/mp4$/i.test(video.mimeType) && !/\.mp4$/i.test(video.name)) {
      return NextResponse.json({ ok: false, error: "Drive dosyası MP4 video olarak tanınmadı." }, { status: 415 });
    }
    if (video.data.length < 12 || video.data.length > 80 * 1024 * 1024 || video.data.toString("ascii", 4, 8) !== "ftyp") {
      return NextResponse.json({ ok: false, error: "MP4 dosyası boş, geçersiz veya 80 MB sınırını aşıyor." }, { status: 415 });
    }
    const metadata = readDriveVideoMetadata(markdownFile.data.toString("utf8"), videoNumber);
    const [item] = await db.insert(contentItems).values({
      title: metadata.title,
      platform: "youtube",
      status: "ready",
      topic: `Google Drive: ${video.name}`,
      updatedAt: new Date(),
    }).returning();
    const [asset] = await db.insert(contentAssets).values({
      contentId: item.id,
      kind: "video",
      mime: "video/mp4",
      data: video.data.toString("base64"),
      bytes: video.data.length,
      meta: {
        source: "google_drive",
        driveFileId: fileId,
        driveFileName: video.name,
        description: metadata.description,
        tags: metadata.tags,
        pinnedComment: metadata.pinnedComment,
        videoNumber,
      },
    }).returning();
    await db.insert(operations).values({
      action: "google_drive_video_import",
      summary: metadata.title,
      status: "success",
      platform: "youtube",
      metadata: {
        contentId: item.id,
        assetId: asset.id,
        driveFileId: fileId,
        driveFileName: video.name,
        videoNumber,
        bytes: video.data.length,
        source: "google_drive",
        uploadApproved: false,
      },
    });
    return NextResponse.json({
      ok: true,
      imported: true,
      contentId: item.id,
      title: metadata.title,
      fileName: video.name,
      bytes: video.data.length,
      source: "google_drive",
      uploadApproved: false,
      message: "Video Drive'dan Mira'nın sunucusuna aktarıldı. YouTube'a yüklenmedi; kullanıcı onayı bekleniyor.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen Drive aktarım hatası";
    return NextResponse.json({ ok: false, error: message.slice(0, 500) }, { status: 502 });
  }
}
