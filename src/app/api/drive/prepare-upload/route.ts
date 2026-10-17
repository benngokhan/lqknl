import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { contentAssets, contentItems, operations } from "@/db/schema";
import { downloadDriveFile, listDriveFolderFiles } from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return true;
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

function cleanSection(value: string) {
  return value.replace(/^\s*```[^\n]*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

function readVideoMetadata(markdown: string, videoNumber: number) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:📹\\s*)?VIDEO\\s+0*${videoNumber}\\b`, "i").test(line));
  if (start < 0) throw new Error(`baslik.md içinde VIDEO ${videoNumber} bölümü bulunamadı.`);
  let end = lines.findIndex((line, index) => index > start && /^\s*(?:#{1,6}\s*)?(?:📹\s*)?VIDEO\s+\d+\b/i.test(line));
  if (end < 0) end = lines.length;
  const block = lines.slice(start, end).join("\n");
  const read = (labels: string[]) => {
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = block.match(new RegExp(`(?:^|\\n)\\s*(?:📌|📝|🏷️|💬)?\\s*\\**${escaped}\\**\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:📌|📝|🏷️|💬)?\\s*\\**[A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ ]{2,}\\**\\s*:|$)`, "i"));
      if (match?.[1]?.trim()) return cleanSection(match[1]);
    }
    return "";
  };
  const title = read(["BAŞLIK", "BASLIK"]);
  if (!title) throw new Error(`VIDEO ${videoNumber} için BAŞLIK alanı baslik.md içinde bulunamadı.`);
  return {
    title: title.replace(/^["'`]|["'`]$/g, "").slice(0, 100),
    description: read(["AÇIKLAMA", "ACIKLAMA"]),
    tags: read(["ETİKETLER", "ETIKETLER"]).split(/[,\n]/).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean).slice(0, 30),
    pinnedComment: read(["SABİT YORUM", "SABIT YORUM"]),
  };
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
    const metadata = readVideoMetadata(markdownFile.data.toString("utf8"), videoNumber);
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
