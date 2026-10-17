import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { downloadDriveFile, listDriveFolderFiles } from "@/lib/google-drive";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  return isMiraSessionCookie(req.headers.get("cookie"));
}

function titleCandidates(markdown: string) {
  return markdown.split(/\r?\n/).flatMap((raw, index) => {
    const line = raw.trim();
    if (!line) return [];
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const list = line.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    const value = (heading?.[1] || list?.[1] || "").trim();
    if (!value) return [];
    const clean = value
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/__(.*?)__/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/_(.*?)_/g, "$1")
      .replace(/\[(.*?)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return [];
    return [{ line: index + 1, kind: heading ? "heading" : "list", title: clean }];
  });
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });
  }

  try {
    const files = await listDriveFolderFiles();
    const titleFile = files.find((file) => file.name.toLocaleLowerCase("tr-TR") === "baslik.md");
    if (!titleFile) {
      return NextResponse.json({
        ok: false,
        error: "Drive klasöründe baslik.md bulunamadı.",
        availableFiles: files.map((file) => file.name),
      }, { status: 404 });
    }

    const downloaded = await downloadDriveFile(titleFile.id);
    const markdown = downloaded.data.toString("utf8");
    const shorts = files
      .filter((file) => /^video_\d+\.mp4$/i.test(file.name))
      .sort((a, b) => Number(a.name.match(/\d+/)?.[0] || 0) - Number(b.name.match(/\d+/)?.[0] || 0));
    const longVideos = files
      .filter((file) => /^uzun_video_\d+\.mp4$/i.test(file.name))
      .sort((a, b) => Number(a.name.match(/\d+/)?.[0] || 0) - Number(b.name.match(/\d+/)?.[0] || 0));

    return NextResponse.json({
      ok: true,
      document: { name: downloaded.name, mimeType: downloaded.mimeType, characters: markdown.length },
      titleCandidates: titleCandidates(markdown),
      videos: { shorts, longVideos },
      // Included for the first verification pass so Mira can use the exact source text, not guesses.
      documentText: markdown,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen Drive hatası";
    return NextResponse.json({ ok: false, error: message.slice(0, 400) }, { status: 502 });
  }
}
