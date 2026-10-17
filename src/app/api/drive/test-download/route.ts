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

  try {
    const files = await listDriveFolderFiles();
    const file = files.find((item) => item.name === "video_1.mp4");

    if (!file) {
      return NextResponse.json({
        ok: false,
        error: "Drive klasöründe video_1.mp4 bulunamadı.",
        availableVideoNames: files
          .filter((item) => /^video_\d+\.mp4$/i.test(item.name))
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
      test: "drive-download-video_1",
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
      test: "drive-download-video_1",
      downloadHttpStatus: match ? Number(match[1]) : null,
      error: message.slice(0, 400),
    }, { status: 502 });
  }
}
