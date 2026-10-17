import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { downloadDriveFile, listDriveFolderFiles } from "@/lib/google-drive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(req: Request) {
  return isMiraSessionCookie(req.headers.get("cookie"));
}

function isVideoName(name: string) {
  return /^(?:video|uzun_video)_\d+\.mp4$/i.test(name);
}

async function testFile(file: Awaited<ReturnType<typeof listDriveFolderFiles>>[number]) {
  try {
    const expectedBytes = Number(file.size || 0);
    const downloaded = await downloadDriveFile(file.id);
    const actualBytes = downloaded.data.length;
    const brand = actualBytes >= 8 ? downloaded.data.subarray(4, 8).toString("ascii") : "";
    const mp4SignatureValid = actualBytes >= 12 && brand === "ftyp";
    const exactSizeMatch = expectedBytes > 0 && actualBytes === expectedBytes;
    const passed = actualBytes > 0 && exactSizeMatch && mp4SignatureValid && downloaded.mimeType === "video/mp4";
    return {
      ok: passed,
      name: file.name,
      expectedBytes,
      actualBytes,
      exactSizeMatch,
      mimeType: downloaded.mimeType,
      mp4SignatureValid,
      error: passed ? undefined : "Boyut, MIME türü veya MP4 imzası doğrulanamadı.",
    };
  } catch (error) {
    return {
      ok: false,
      name: file.name,
      expectedBytes: Number(file.size || 0),
      actualBytes: 0,
      exactSizeMatch: false,
      mimeType: file.mimeType,
      mp4SignatureValid: false,
      error: (error instanceof Error ? error.message : "Bilinmeyen Drive hatası").slice(0, 300),
    };
  }
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });
  }

  const url = new URL(req.url);
  const requestedName = url.searchParams.get("file") || "video_1.mp4";
  const testAll = url.searchParams.get("all") === "1";

  if (!testAll && !isVideoName(requestedName)) {
    return NextResponse.json({ ok: false, error: "Geçersiz dosya adı." }, { status: 400 });
  }

  try {
    const files = await listDriveFolderFiles();
    const videos = files.filter((item) => isVideoName(item.name));
    if (testAll) {
      if (!videos.length) {
        return NextResponse.json({ ok: false, error: "Drive klasöründe MP4 video bulunamadı.", results: [] }, { status: 404 });
      }
      const results = [];
      for (const file of videos) results.push(await testFile(file));
      const passed = results.filter((item) => item.ok).length;
      const failed = results.length - passed;
      return NextResponse.json({
        ok: failed === 0,
        test: "drive-download-all-videos",
        total: results.length,
        passed,
        failed,
        results,
        message: failed === 0
          ? "Drive klasöründeki tüm MP4 videolar indirildi ve doğrulandı."
          : "Bazı videolar doğrulanamadı. Hatalı dosyalar results bölümünde listeleniyor.",
      }, { status: failed === 0 ? 200 : 422 });
    }

    const file = videos.find((item) => item.name.toLowerCase() === requestedName.toLowerCase());
    if (!file) {
      return NextResponse.json({
        ok: false,
        error: `${requestedName} Drive klasöründe bulunamadı.`,
        availableVideoNames: videos.map((item) => item.name),
      }, { status: 404 });
    }
    const result = await testFile(file);
    return NextResponse.json({
      ...result,
      test: `drive-download-${requestedName}`,
      downloadHttpStatus: result.ok ? 200 : 422,
      message: result.ok
        ? "Drive dosyası indirildi; boyut, MIME türü ve MP4 imzası doğrulandı."
        : result.error,
    }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen Drive hatası";
    const match = message.match(/HTTP\s+(\d{3})/i);
    return NextResponse.json({
      ok: false,
      test: testAll ? "drive-download-all-videos" : `drive-download-${requestedName}`,
      downloadHttpStatus: match ? Number(match[1]) : null,
      error: message.slice(0, 400),
    }, { status: 502 });
  }
}
