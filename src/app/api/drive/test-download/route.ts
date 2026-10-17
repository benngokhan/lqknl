import { NextResponse } from "next/server";
import { downloadDriveFile, listDriveFolderFiles } from "@/lib/google-drive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorized(req: Request) {
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Mira giriş oturumu gerekli." }, { status: 401 });
  }

  const requestedName = new URL(req.url).searchParams.get("file") || "video_1.mp4";
  if (!/^(?:video|uzun_video)_\d+\.mp4$/i.test(requestedName)) {
    return NextResponse.json({
      ok: false,
      error: "Geçersiz dosya adı. video_2.mp4 veya uzun_video_3.mp4 gibi bir ad kullan.",
    }, { status: 400 });
  }

  const testName = `drive-download-${requestedName}`;

  try {
    const files = await listDriveFolderFiles();
    const file = files.find((item) => item.name.toLowerCase() === requestedName.toLowerCase());

    if (!file) {
      return NextResponse.json({
        ok: false,
        test: testName,
        error: `${requestedName} Drive klasöründe bulunamadı.`,
        availableVideoNames: files
          .filter((item) => /^(?:video|uzun_video)_\d+\.mp4$/i.test(item.name))
          .map((item) => item.name),
      }, { status: 404 });
    }

    const expectedBytes = Number(file.size || 0);
    const downloaded = await downloadDriveFile(file.id);
    const actualBytes = downloaded.data.length;
    const first12Hex = downloaded.data.subarray(0, 12).toString("hex");
    const brand = downloaded.data.length >= 8
      ? downloaded.data.subarray(4, 8).toString("ascii")
      : "";
    const mp4SignatureValid = downloaded.data.length >= 12 && brand === "ftyp";
    const exactSizeMatch = expectedBytes > 0 && actualBytes === expectedBytes;
    const passed = actualBytes > 0 && exactSizeMatch && mp4SignatureValid;

    return NextResponse.json({
      ok: passed,
      test: testName,
      file: {
        name: downloaded.name,
        id: file.id,
        mimeType: downloaded.mimeType,
        expectedBytes,
        actualBytes,
        exactSizeMatch,
        first12Hex,
        brand,
        mp4SignatureValid,
      },
      downloadHttpStatus: 200,
      message: passed
        ? "Drive dosyası indirildi; bayt sayısı ve MP4 ftyp imzası doğrulandı."
        : "İndirme yanıt verdi ancak boyut veya MP4 imzası doğrulaması başarısız.",
    }, { status: passed ? 200 : 422 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen Drive hatası";
    const match = message.match(/HTTP\s+(\d{3})/i);
    return NextResponse.json({
      ok: false,
      test: testName,
      downloadHttpStatus: match ? Number(match[1]) : null,
      error: message.slice(0, 400),
    }, { status: 502 });
  }
}
