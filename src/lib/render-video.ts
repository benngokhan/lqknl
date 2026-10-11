// MP4 render çekirdeği: /api/video/render route'u ve üretim motoru (produce)
// tarafından ortak kullanılır. Girdi/çıktı tamamen bellek içi Buffer'larla çalışır.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

export type Caption = { start: number; end: number; text: string };

export type RenderImage = { bytes: Buffer; extension: string };

export type RenderInput = {
  images: RenderImage[]; // tam olarak 3
  audio: Buffer;
  captions?: Caption[];
  narrationText?: string;
  durationSeconds?: number;
};

export type RenderOutput = {
  video: Buffer;
  durationSeconds: number;
  captionsUsed: number;
};

function srtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  return [hh, mm, ss].map((n) => String(n).padStart(2, "0")).join(":") + "," + String(mmm).padStart(3, "0");
}

function safeCaptions(value: Caption[] | undefined, duration: number): Caption[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const start = Number(c.start);
    const end = Number(c.end);
    const text = typeof c.text === "string" ? c.text.replace(/[\r\n]+/g, " ").trim().slice(0, 180) : "";
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return [];
    const a = Math.max(0, Math.min(duration, start));
    const b = Math.max(0, Math.min(duration, end));
    return b > a ? [{ start: a, end: b, text }] : [];
  });
}

function estimateCaptions(text: string, duration: number): Caption[] {
  const phrases = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+|(?<=,\s)/u)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 24);
  if (!phrases.length) return [];
  const total = phrases.reduce((sum, phrase) => sum + Math.max(1, phrase.length), 0);
  let cursor = 0;
  return phrases.map((phrase) => {
    const start = cursor;
    cursor += duration * Math.max(1, phrase.length) / total;
    return { start, end: Math.min(duration, cursor), text: phrase };
  });
}

function probeAudioDuration(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(null);
    const child = spawn(ffmpegPath, ["-hide_banner", "-i", filePath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) return resolve(null);
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    });
  });
}

function escapeFilterPath(value: string) {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function runFfmpeg(args: string[], timeoutMs = 120_000, env: NodeJS.ProcessEnv = process.env) {
  return new Promise<void>((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("FFmpeg çalıştırılabilir dosyası bulunamadı"));
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-6000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Video üretimi zaman aşımına uğradı"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error("FFmpeg hata verdi: " + stderr.slice(-1800)));
    });
  });
}

export async function renderShort(input: RenderInput): Promise<RenderOutput> {
  if (!Array.isArray(input.images) || input.images.length !== 3) {
    throw new Error("Tam olarak 3 görsel gerekli");
  }
  for (const [index, image] of input.images.entries()) {
    if (!image || !image.bytes || !image.bytes.length) throw new Error(`Görsel ${index + 1} boş`);
  }
  if (!input.audio || !input.audio.length) throw new Error("Ses verisi boş");

  let workDir = "";
  try {
    workDir = await mkdtemp(path.join(tmpdir(), "mira-mp4-"));
    const imagePaths: string[] = [];
    for (let i = 0; i < input.images.length; i++) {
      const extension = (input.images[i].extension || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
      const imagePath = path.join(workDir, `image-${i + 1}.${extension}`);
      await writeFile(imagePath, input.images[i].bytes);
      imagePaths.push(imagePath);
    }
    const audioPath = path.join(workDir, "voice.mp3");
    const srtPath = path.join(workDir, "captions.srt");
    const outputPath = path.join(workDir, "mira-short.mp4");
    await writeFile(audioPath, input.audio);

    // Süre: parametre, yoksa ses dosyasından ölçüm, son çare 20s
    const requested = Number(input.durationSeconds);
    const probed = await probeAudioDuration(audioPath);
    const base = Number.isFinite(requested) && requested > 0 ? requested : (probed ?? 20);
    const duration = Math.max(4, Math.min(90, base + 0.4));

    const captions = safeCaptions(input.captions, duration);
    const finalCaptions = captions.length
      ? captions
      : (typeof input.narrationText === "string" ? estimateCaptions(input.narrationText.slice(0, 5000), duration) : []);
    if (!finalCaptions.length) {
      throw new Error("Altyazı için captions zamanları veya narrationText gerekli");
    }
    const srt = finalCaptions.map((caption, index) =>
      `${index + 1}\n${srtTime(caption.start)} --> ${srtTime(caption.end)}\n${caption.text}\n`
    ).join("\n");
    await writeFile(srtPath, srt, "utf8");

    const segment = duration / 3;
    const filters = imagePaths.map((_, index) =>
      `[${index}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0005,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30,setsar=1[v${index}]`
    );
    // libass'ın FontSize/MarginV değerleri PlayResY=288 birimindedir; 1080x1920'e ölçeklenir.
    // fontsdir: Railway imajında sistem fontu bulunmayabileceğinden proje içi font klasörünü kullan.
    const fontsDir = path.join(process.cwd(), "public", "fonts");
    const subtitleStyle = "FontName=DejaVu Sans,FontSize=17,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=34";
    filters.push(`[v0][v1][v2]concat=n=3:v=1:a=0,subtitles=${escapeFilterPath(srtPath)}:fontsdir='${escapeFilterPath(fontsDir)}':force_style='${subtitleStyle}'[vout]`);

    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    for (const imagePath of imagePaths) {
      args.push("-loop", "1", "-framerate", "30", "-t", String(segment), "-i", imagePath);
    }
    args.push("-i", audioPath);
    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "[vout]", "-map", "3:a",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-pix_fmt", "yuv420p", "-r", "30",
      "-c:a", "aac", "-b:a", "128k", "-af", "apad",
      "-t", String(duration), "-movflags", "+faststart",
      outputPath,
    );

    // libass Fontconfig'in varsayılan sistem yapılandırmasını bulamayabilir (Railway/Nixpacks).
    // Her render için geçici bir config üretip proje içindeki DejaVu fontlarını açıkça tanımla.
    const fontconfigCacheDir = path.join(workDir, "fontconfig-cache");
    await mkdir(fontconfigCacheDir, { recursive: true });
    const fontconfigFile = path.join(workDir, "fonts.conf");
    await writeFile(fontconfigFile, [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
      '<fontconfig>',
      `  <dir>${fontsDir}</dir>`,
      '  <dir>/usr/share/fonts</dir>',
      '  <dir>/usr/local/share/fonts</dir>',
      `  <cachedir>${fontconfigCacheDir}</cachedir>`,
      '</fontconfig>',
      '',
    ].join("\n"), "utf8");

    await runFfmpeg(args, 120_000, { FONTCONFIG_FILE: fontconfigFile, FONTCONFIG_PATH: workDir });
    const video = await readFile(outputPath);
    if (video.length < 10_000 || video.subarray(4, 8).toString("ascii") !== "ftyp") {
      throw new Error("Üretilen dosya geçerli MP4 olarak doğrulanamadı");
    }

    console.log("[Mira MP4] render success", JSON.stringify({
      bytes: video.length,
      durationSeconds: duration,
      captions: finalCaptions.length,
    }));
    return { video, durationSeconds: duration, captionsUsed: finalCaptions.length };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
