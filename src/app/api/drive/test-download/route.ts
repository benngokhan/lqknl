import { isMiraSessionCookie } from "@/lib/mira-auth";
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";

type VideoTechnicalInfo = {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  hasAudio: boolean;
};

async function inspectVideo(data: Buffer): Promise<VideoTechnicalInfo> {
  const binaryPath = ffmpegPath;
  if (typeof binaryPath !== "string" || !binaryPath) {
    throw new Error("FFmpeg binary yolu bulunamadı; ffmpeg-static kurulumu kontrol edilmeli.");
  }

  // MP4 dosyaları pipe üzerinden okunurken, özellikle moov atomu dosyanın
  // sonundaysa FFmpeg dosyayı eksik görebilir. Geçici dosyaya yazıp dosya
  // yolundan incelemek, gerçek MP4 seek davranışını kullanır.
  const tempDir = await mkdtemp(join(tmpdir(), "mira-drive-video-"));
  const tempFile = join(tempDir, "input.mp4");
  try {
    await writeFile(tempFile, data);
    return await new Promise((resolve, reject) => {
      const child = spawn(binaryPath, ["-hide_banner", "-i", tempFile, "-t", "0.1", "-f", "null", "-"], {
        stdio: ["ignore", "ignore", "pipe"] as const,
      });
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          reject(new Error("Video teknik analizi 30 saniyede tamamlanmadı."));
        }
      }, 30_000);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-40_000); });
      child.on("error", (error) => {
        clearTimeout(timeout);
        if (!settled) { settled = true; reject(new Error("FFmpeg başlatılamadı: " + error.message)); }
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
        const videoLine = stderr.split(/\r?\n/).find((line) => /Video:/i.test(line)) || "";
        const dimensions = videoLine.match(/(\d{2,5})x(\d{2,5})/);
        const fpsMatch = videoLine.match(/([\d.]+)\s*fps\b/i) || videoLine.match(/([\d.]+)\s*tbr\b/i);
        const info: VideoTechnicalInfo = {
          durationSeconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
          width: dimensions ? Number(dimensions[1]) : null,
          height: dimensions ? Number(dimensions[2]) : null,
          frameRate: fpsMatch ? Number(fpsMatch[1]) : null,
          hasAudio: /Audio:/i.test(stderr),
        };
        if (code !== 0 || !videoLine || info.width === null || info.height === null) {
          reject(new Error("FFmpeg dosyadan geçerli video akışı okuyamadı. " + stderr.slice(-1200)));
          return;
        }
        resolve(info);
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}


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
    const fileValid = actualBytes > 0 && exactSizeMatch && mp4SignatureValid && downloaded.mimeType === "video/mp4";
    if (!fileValid) {
      return {
        ok: false, name: file.name, expectedBytes, actualBytes, exactSizeMatch,
        mimeType: downloaded.mimeType, mp4SignatureValid,
        error: "Boyut, MIME türü veya MP4 imzası doğrulanamadı.",
      };
    }
    const technical = await inspectVideo(downloaded.data);
    return {
      ok: true,
      name: file.name,
      expectedBytes,
      actualBytes,
      exactSizeMatch,
      mimeType: downloaded.mimeType,
      mp4SignatureValid,
      ...technical,
      shortsReady: technical.durationSeconds !== null && technical.durationSeconds <= 180 &&
        technical.width !== null && technical.height !== null && technical.height > technical.width,
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
        ? "Drive dosyası indirildi; dosya bütünlüğü ve FFmpeg ile teknik video bilgileri doğrulandı."
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
