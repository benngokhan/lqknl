import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { downloadDriveFile, listDriveFolderFiles } from "@/lib/google-drive";
import { readDriveSpreadsheetCatalog } from "@/lib/drive-video-xlsx";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  return isMiraSessionCookie(req.headers.get("cookie"));
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });
  }

  try {
    const files = await listDriveFolderFiles();
    const metadataFiles = files.filter((file) => file.name.toLocaleLowerCase("tr-TR") === "baslik.xlsx");
    if (metadataFiles.length !== 1) {
      return NextResponse.json({
        ok: false,
        error: metadataFiles.length
          ? "Drive klasöründe birden fazla baslik.xlsx dosyası var."
          : "Drive klasöründe baslik.xlsx bulunamadı.",
        availableFiles: files.map((file) => file.name),
      }, { status: metadataFiles.length ? 409 : 404 });
    }

    const downloaded = await downloadDriveFile(metadataFiles[0].id);
    const metadata = readDriveSpreadsheetCatalog(downloaded.data);
    const shorts = files
      .filter((file) => /^video_\d+\.mp4$/i.test(file.name))
      .sort((a, b) => Number(a.name.match(/\d+/)?.[0] || 0) - Number(b.name.match(/\d+/)?.[0] || 0));
    const longVideos = files
      .filter((file) => /^uzun_video_\d+\.mp4$/i.test(file.name))
      .sort((a, b) => Number(a.name.match(/\d+/)?.[0] || 0) - Number(b.name.match(/\d+/)?.[0] || 0));

    return NextResponse.json({
      ok: true,
      document: { name: downloaded.name, mimeType: downloaded.mimeType, bytes: downloaded.data.length },
      metadataRows: metadata,
      videos: { shorts, longVideos },
      source: "Google Drive / baslik.xlsx",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen Drive hatası";
    return NextResponse.json({ ok: false, error: message.slice(0, 400) }, { status: 502 });
  }
}
