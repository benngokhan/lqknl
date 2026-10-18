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
    // Prefer the expected filename, but support the same workbook uploaded as
    // "baslik" without an extension. The workbook parser below verifies that
    // the bytes are actually readable as an Excel workbook.
    const exactMetadataFiles = files.filter((file) => file.name.toLocaleLowerCase("tr-TR") === "baslik.xlsx");
    const extensionlessMetadataFiles = files.filter((file) => file.name.toLocaleLowerCase("tr-TR") === "baslik");
    const metadataFiles = exactMetadataFiles.length ? exactMetadataFiles : extensionlessMetadataFiles;
    if (metadataFiles.length !== 1) {
      return NextResponse.json({
        ok: false,
        error: metadataFiles.length
          ? "Drive klasöründe birden fazla olası baslik Excel dosyası var."
          : "Drive klasöründe baslik.xlsx veya uzantısız baslik dosyası bulunamadı.",
        availableFiles: files.map((file) => ({ name: file.name, mimeType: file.mimeType })),
      }, { status: metadataFiles.length ? 409 : 404 });
    }

    const downloaded = await downloadDriveFile(metadataFiles[0].id);
    let metadata;
    try {
      metadata = readDriveSpreadsheetCatalog(downloaded.data);
    } catch {
      return NextResponse.json({
        ok: false,
        error: `Drive'daki "${downloaded.name}" dosyası Excel çalışma kitabı olarak okunamadı. Dosya türü: ${downloaded.mimeType}.`,
        document: { name: downloaded.name, mimeType: downloaded.mimeType, bytes: downloaded.data.length },
      }, { status: 415 });
    }
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
