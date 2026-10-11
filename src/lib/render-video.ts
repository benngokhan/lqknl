// MP4 render çekirdeği: /api/video/render route'u ve üretim motoru (produce)
// tarafından ortak kullanılır. Girdi/çıktı tamamen bellek içi Buffer'larla çalışır.
//
// Bellek notu (Railway SIGKILL sorunu, 2. perde): V1'de segmentler kodlanıyordu ama son
// geçişte 3 segment concat edilip VİDEO BAŞTAN SONA YENİDEN x264 ile kodlanıyordu
// (altyazı yakma filtresi zorunlu kılıyordu) — 1080x1920 tam süre re-encode küçük
// Railway container'ında SIGKILL yiyordu. V2: altyazı segment başına yakılıyor
// (zaman penceresi kaydırılmış SRT), son geçiş concat demuxer + `-c:v copy` ile saf
// mux'a indi.
//
// 3. perde (dumpartan gözlem: segment bile ~1sn'de SIGKILL): artık çözünürlük
// merdiveni var — önce 1080x1920, kill-benzeri hata (SIGKILL/SIGSEGV/ENOMEM/zaman aşımı)
// olursa otomatik 720x1280'e düşer. MIRA_RENDER_PROFILE=hi|low ile profil sürülebilir.
// Ayrıca ffmpeg'in gerçek tepe RSS'i (Linux /proc) ölçülüp log ve hata mesajına yazılır.

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
  profile: string;
};

type RenderProfile = {
  name: string;
  width: number;
  height: number;
  preset: string;
  crf: number;
  fontSize: number;
  fps: number;
  threads: number;
};

function buildProfiles(): RenderProfile[] {
  const hi: RenderProfile = { name: "hi", width: 1080, height: 1920, preset: "ultrafast", crf: 23, fontSize: 17, fps: 30, threads: 0 };
  // low: 720x1280 + 24fps + tek iş parçacığı — a33f389'daki yük azaltma yaklaşımının korunan kısmı;
  // zoompan merdiven gereği niche gerekli küçük krediyle korunur (bellekte ölçülü fark)
  const low: RenderProfile = { name: "low", width: 720, height: 1280, preset: "ultrafast", crf: 25, fontSize: 11, fps: 24, threads: 1 };
  const forced = (process.env.MIRA_RENDER_PROFILE || "").trim().toLowerCase();
  if (forced === "low") return [low];
  if (forced === "hi") return [hi];
  return [hi, low];
}

/** SIGKILL/SIGSEGV/ENOMEM/zaman aşımı gibi ortam kaynaklı ölümlerde düşük profil denemeye değer;
 *  argüman/veri hatalarında tekrar tekrar denemek anlamsız. */
export function isRetryableKillError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /signal=(SIGKILL|SIGSEGV|SIGABRT)|ENOMEM|out of memory|killed|zaman aşımı/i.test(msg);
}

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

// Küresel zamanlı altyazıları bir segment penceresine taşı: kesişimi al, pencere
// başlangıcını çıkar. Sınırı aşan altyazı iki segmentte de görünür (ikisinde de kırpılır).
function captionsForWindow(captions: Caption[], start: number, end: number): Caption[] {
  return captions.flatMap((c) => {
    const a = Math.max(c.start, start);
    const b = Math.min(c.end, end);
    return b - a > 0.05 ? [{ start: a - start, end: b - start, text: c.text }] : [];
  });
}

function buildSrt(captions: Caption[]) {
  return captions.map((caption, index) =>
    `${index + 1}\n${srtTime(caption.start)} --> ${srtTime(caption.end)}\n${caption.text}\n`
  ).join("\n");
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

async function sampleRssKb(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = status.match(/VmRSS:\s*(\d+)\s*kB/);
    return match ? Number(match[1]) : null;
  } catch {
    return null; // süreç bitti ya da Linux dışı ortam
  }
}

function runFfmpeg(args: string[], timeoutMs = 120_000, env: Partial<NodeJS.ProcessEnv> = process.env) {
  return new Promise<{ peakRssMb: number | null }>((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("FFmpeg çalıştırılabilir dosyası bulunamadı"));
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...env } });
    let stderr = "";
    let settled = false;
    let peakKb = 0;
    // Gerçek RAM kullanımını gör: her 250ms'de çocuğun RSS'ini örnekle (Railway OOM teşhisi için)
    const rssTimer = setInterval(() => {
      if (!child.pid) return;
      void sampleRssKb(child.pid).then((kb) => {
        if (kb && kb > peakKb) peakKb = kb;
      });
    }, 250);
    const peakRss = (): number | null => (peakKb > 0 ? Math.round(peakKb / 1024) : null);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(rssTimer);
      if (error) reject(error);
      else resolve({ peakRssMb: peakRss() });
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-12000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`FFmpeg zaman aşımı: ${timeoutMs}ms; tepe RSS≈${peakRss() ?? "?"}MB; son çıktı: ${stderr.slice(-2500) || "(stderr boş)"}`));
    }, timeoutMs);
    child.on("error", (error) => {
      finish(new Error(`FFmpeg başlatılamadı: ${error.message}; binary=${ffmpegPath}`));
    });
    child.on("close", (code, signal) => {
      if (code === 0) return finish();
      const output = stderr.trim() || "(FFmpeg stderr boş)";
      finish(new Error(`FFmpeg hata verdi (exit=${String(code)}, signal=${String(signal)}; tepe RSS≈${peakRss() ?? "?"}MB): ${output.slice(-2500)}`));
    });
  });
}

export async function renderShort(input: RenderInput): Promise<RenderOutput> {
  const profiles = buildProfiles();
  let lastError: unknown = null;
  for (const profile of profiles) {
    try {
      const result = await renderShortWithProfile(input, profile);
      if (profile.name !== profiles[0].name) {
        console.log(`[Mira MP4] profil düşürüldü: ${profiles[0].name} başarısız olduğu için ${profile.name} ile üretildi`);
      }
      return result;
    } catch (error) {
      lastError = error;
      const killish = isRetryableKillError(error);
      console.error(`[Mira MP4] profil=${profile.name} başarısız (retryable=${killish}):`, error instanceof Error ? error.message.slice(0, 400) : String(error));
      if (!killish || profile === profiles[profiles.length - 1]) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function renderShortWithProfile(input: RenderInput, profile: RenderProfile): Promise<RenderOutput> {
  if (!Array.isArray(input.images) || input.images.length !== 3) {
    throw new Error("Tam olarak 3 görsel gerekli");
  }
  for (const [index, image] of input.images.entries()) {
    if (!image || !image.bytes || !image.bytes.length) throw new Error(`Görsel ${index + 1} boş`);
  }
  if (!input.audio || !input.audio.length) throw new Error("Ses verisi boş");

  let workDir = "";
  let peakRssMb: number | null = null;
  const notePeak = (value: number | null) => {
    if (value !== null && (peakRssMb === null || value > peakRssMb)) peakRssMb = value;
  };
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

    // libass Fontconfig'in varsayılan sistem yapılandırmasını bulamayabilir (Railway/Nixpacks).
    // Her render için geçici bir config üretip proje içindeki DejaVu fontlarını açıkça tanımla.
    const fontsDir = path.join(process.cwd(), "public", "fonts");
    const fontconfigCacheDir = path.join(workDir, "fontconfig-cache");
    await mkdir(fontconfigCacheDir, { recursive: true });
    const fontconfigFile = path.join(workDir, "fonts.conf");
    await writeFile(fontconfigFile, [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
      "<fontconfig>",
      `  <dir>${fontsDir}</dir>`,
      "  <dir>/usr/share/fonts</dir>",
      "  <dir>/usr/local/share/fonts</dir>",
      `  <cachedir>${fontconfigCacheDir}</cachedir>`,
      "</fontconfig>",
      "",
    ].join("\n"), "utf8");
    const ffenv = { FONTCONFIG_FILE: fontconfigFile, FONTCONFIG_PATH: workDir };

    // libass'ın FontSize/MarginV değerleri PlayResY=288 birimindedir; çerçeve yüksekliğine ölçeklenir.
    const subtitleStyle = `FontName=DejaVu Sans,FontSize=${profile.fontSize},Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=34`;

    const segment = duration / 3;
    const { width, height, fps } = profile;

    // 1-3) Her görsel ayrı .mp4 segmentine kodlanır; o segmentin zaman penceresine düşen
    // altyazılar da burada yakılır. Tek görsel + kısa süre = düşük RAM.
    // (NOT: .ts segmentleri bu ffmpeg build'inde Node'dan spawn edilince segfault veriyordu
    // — mp4 segmentleri bu yüzden bilinçli seçimdir.)
    const segmentPaths: string[] = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const segmentPath = path.join(workDir, `segment-${i + 1}.mp4`);
      const segStart = i * segment;
      const segCaptions = captionsForWindow(finalCaptions, segStart, segStart + segment);
      let vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='min(zoom+0.0005,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps},setsar=1`;
      if (segCaptions.length) {
        const srtPath = path.join(workDir, `captions-${i + 1}.srt`);
        await writeFile(srtPath, buildSrt(segCaptions), "utf8");
        vf += `,subtitles=${escapeFilterPath(srtPath)}:fontsdir='${escapeFilterPath(fontsDir)}':force_style='${subtitleStyle}'`;
      }
      const encodeArgs = [
        "-c:v", "libx264", "-preset", profile.preset, "-crf", String(profile.crf),
        "-pix_fmt", "yuv420p",
        ...(profile.threads > 0 ? ["-threads", String(profile.threads)] : []),
        "-an",
      ];
      const run = await runFfmpeg([
        "-hide_banner", "-loglevel", "warning", "-y",
        "-loop", "1", "-framerate", String(fps), "-t", String(segment), "-i", imagePaths[i],
        "-vf", vf,
        ...encodeArgs,
        segmentPath,
      ], 120_000, ffenv);
      notePeak(run.peakRssMb);
      segmentPaths.push(segmentPath);
    }

    // 4) Final: concat demuxer ile 3 segmenti birleştir + ses muxla.
    // VİDEO YENİDEN KODLANMIYOR (-c:v copy) → bu geçiş neredeyse belleksiz çalışır.
    const concatListPath = path.join(workDir, "concat.txt");
    await writeFile(
      concatListPath,
      segmentPaths.map((p) => `file '${p}'`).join("\n"),
      "utf8",
    );
    const muxRun = await runFfmpeg([
      "-hide_banner", "-loglevel", "warning", "-y",
      "-f", "concat", "-safe", "0", "-i", concatListPath,
      "-i", audioPath,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "128k", "-af", "apad",
      "-t", String(duration), "-movflags", "+faststart",
      outputPath,
    ], 120_000, ffenv);
    notePeak(muxRun.peakRssMb);

    const video = await readFile(outputPath);
    if (video.length < 10_000 || video.subarray(4, 8).toString("ascii") !== "ftyp") {
      throw new Error("Üretilen dosya geçerli MP4 olarak doğrulanamadı");
    }

    console.log("[Mira MP4] render success (segmented, copy-merge)", JSON.stringify({
      profile: profile.name,
      resolution: `${width}x${height}@${fps}`,
      ffmpegPeakMb: peakRssMb,
      bytes: video.length,
      durationSeconds: duration,
      captions: finalCaptions.length,
    }));
    return { video, durationSeconds: duration, captionsUsed: finalCaptions.length, profile: profile.name };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
