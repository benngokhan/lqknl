import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

/**
 * MİRA × BİLGİ DOZU PYTHON MOTOR KÖPRÜSÜ
 * Vendored motoru (motor/shorts_pipeline.py) TS hattından çağırır:
 * TTS + 3 görsel + anlatı metni → PIL şablonlu 720x1280@24 MP4 (marka çerçevesi,
 * kelime-kelime altyazı, müzik yatağı + ducking, -14 LUFS master).
 * Herhangi bir hata durumunda çağıran taraf (produce) TS/ffmpeg merdivenine düşer.
 */

const MOTOR_DIR = path.join(process.cwd(), "motor");
const PIPELINE = path.join(MOTOR_DIR, "shorts_pipeline.py");
const QC = path.join(MOTOR_DIR, "qc_check.py");

export interface MotorDesign {
  title: unknown[][];
  note1: string;
  note2: string;
  accents: string[];
  seoTitle: string;
}

export interface MotorRenderInput {
  contentId: number;
  narrationText: string;
  audioMp3: Buffer | Uint8Array;
  images: { bytes: Buffer | Uint8Array }[];
  design: MotorDesign;
}

export interface MotorRenderResult {
  video: Buffer;
  durationSeconds: number | null;
  qcOutput: string;
  renderMs: number;
  pythonPath: string;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${path.basename(cmd)} zaman aşımı (${Math.round(opts.timeoutMs / 1000)}s)`)); }, opts.timeoutMs);
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (c: string) => { stdout = (stdout + c).slice(-6000); });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (c: string) => { stderr = (stderr + c).slice(-6000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? -1 }); });
  });
}

let pythonCache: string | null | undefined;

/** python3 + pillow/numpy/imageio-ffmpeg var mı? (Railway değişmezse cache'lenir) */
export async function pythonAvailable(): Promise<string | null> {
  if (pythonCache !== undefined) return pythonCache;
  for (const bin of ["python3", "python"]) {
    const check = await run(bin, ["-c", "import PIL, numpy, imageio_ffmpeg, sys; print(sys.executable.split('/')[-1])"], { timeoutMs: 25_000 }).catch(() => null);
    if (check && check.code === 0) { pythonCache = bin; return bin; }
  }
  pythonCache = null;
  return null;
}

/**
 * Senaryo bölümlerinden marka tasarım alanları çıkarır.
 * Öncelik: worker'ın yeni TASARIM bloğu (JSON satır). Yoksa sezgisel geri doldur:
 * başlık = başlıktan büyük harf satırları (son satır yeşil), note1 = EKRAN METNİ/AÇIKLAMA,
 * note2 = KAYNAK, accents = metindeki sayısal/özel kelimeler.
 */
export function buildMotorDesign(opts: {
  designSection?: string;
  title: string;
  topic: string;
  narration: string;
  sections: Record<string, string>;
}): MotorDesign {
  if (opts.designSection) {
    const jsonLine = opts.designSection.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .find((l) => l.startsWith("{") && l.includes("\"title\""));
    if (jsonLine) {
      try {
        const parsed = JSON.parse(jsonLine) as Partial<MotorDesign>;
        if (Array.isArray(parsed.title) && parsed.note1 && parsed.note2) {
          return {
            title: parsed.title as unknown[][],
            note1: String(parsed.note1).slice(0, 90),
            note2: String(parsed.note2).slice(0, 90),
            accents: Array.isArray(parsed.accents) ? parsed.accents.slice(0, 5).map(String) : [],
            seoTitle: typeof parsed.seoTitle === "string" ? parsed.seoTitle.slice(0, 95) : opts.title.slice(0, 95),
          };
        }
      } catch { /* sezgisel moda düş */ }
    }
  }

  const tr = (t: string) => t.toLocaleUpperCase("tr-TR");
  // Başlık: ~22 karakter/s satıra böl; son satır yeşil segment (referans şablonla aynı)
  const words = tr(opts.title).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > 22 && cur) { lines.push(cur); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  const titleLines = lines.slice(0, 3).map((l, i, arr) =>
    i === arr.length - 1 ? [[l, "g"]] : [l]);
  if (lines.length > 3) titleLines[2] = [[lines.slice(2).join(" "), "g"]];

  const firstLine = (s: string) => (s.split(/\r?\n/).map((l) => l.replace(/^\s*[-*•]\s+/, "").trim())
    .find((l) => l.length > 4) || "").replace(/\*\*/g, "");
  const note1Src = firstLine(opts.sections["EKRAN METNİ"] || "") || firstLine(opts.sections["AÇIKLAMA"] || "") || opts.topic;
  const note1 = tr(note1Src).replace(/\[[^\]]*\]/g, "").slice(0, 82);
  const kaynakRaw = firstLine(opts.sections["KAYNAK"] || "");
  const note2 = kaynakRaw && !/DOĞRULAMA GEREKLİ/i.test(kaynakRaw)
    ? tr(kaynakRaw).slice(0, 82)
    : "BİLGİ DOZU EDİTÖR DERLEMESİ (2026)";

  const accWords = new Set<string>();
  for (const m of opts.narration.matchAll(/\d[\d.,]*\s*TL|TMSF|TSDF|[A-ZÇĞİÖŞÜ]{4,}/g)) accWords.add(m[0].toLowerCase());
  const setWords = new Set(opts.narration.toLocaleLowerCase("tr-TR").split(/\s+/).map((w) => w.replace(/[.,!?]/g, "")));
  const accents = [...accWords].filter((a) => setWords.has(a)).slice(0, 5);

  return { title: titleLines, note1, note2, accents, seoTitle: opts.title.slice(0, 95) };
}

export async function renderWithMotor(input: MotorRenderInput): Promise<MotorRenderResult> {
  if (!ffmpegPath) throw new Error("ffmpeg-static yok");
  const py = await pythonAvailable();
  if (!py) throw new Error("python3 + pillow yok (TS/ffmpeg merdivenine düşülecek)");
  const t0 = Date.now();
  const vid = `s${input.contentId}_mira`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mira-motor-"));
  try {
    const shortsDir = path.join(root, "shorts");
    const vd = path.join(shortsDir, vid);
    await fs.mkdir(vd, { recursive: true });

    const mp3Path = path.join(root, "vo.mp3");
    await fs.writeFile(mp3Path, Buffer.from(input.audioMp3));
    const wavPath = path.join(vd, "vo_raw.wav");
    const conv = await run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-i", mp3Path, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", wavPath], { timeoutMs: 60_000 });
    if (conv.code !== 0) throw new Error(`ses dönüşümü başarısız: ${conv.stderr.slice(-150)}`);

    const pick = [input.images[0], input.images[Math.min(2, input.images.length - 1)]].filter(Boolean);
    if (pick.length < 1) throw new Error("bg görsel yok");
    await fs.writeFile(path.join(vd, "bg1.png"), Buffer.from(pick[0].bytes));
    await fs.writeFile(path.join(vd, "bg2.png"), Buffer.from(pick[pick.length - 1].bytes));

    // script.txt = söylenen metinle birebir aynı olmalı (kelime hizalaması VO sessizliklerinden çıkarılıyor)
    await fs.writeFile(path.join(vd, "script.txt"), input.narrationText.trim() + "\n", "utf8");

    const cfgPath = path.join(shortsDir, "shorts_config.json");
    const cfg = {
      [vd]: {
        title: input.design.title,
        note1: input.design.note1,
        note2: input.design.note2,
        accents: input.design.accents,
        seo_title: input.design.seoTitle,
        scenes: ["bg1.png", "bg2.png"],
        youtube_meta: { description: "", tags: [] },
      },
    };
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 1), "utf8");

    const env = { ...process.env, MIRA_SHORTS_CONFIG: cfgPath, MIRA_MOTOR_FFMPEG: ffmpegPath };
    const render = await run(py, [PIPELINE, "all", vd], { env, timeoutMs: 15 * 60_000 });
    const videoPath = path.join(vd, "video.mp4");
    const st = await fs.stat(videoPath).catch(() => null);
    if (!st || st.size < 50_000 || render.code !== 0) {
      throw new Error(`motor render başarısız (kod ${render.code}): ${(render.stderr || render.stdout).slice(-300)}`);
    }

    const lo = Number(process.env.MIRA_MOTOR_QC_LO) > 0 ? Number(process.env.MIRA_MOTOR_QC_LO) : 12;
    const hi = Number(process.env.MIRA_MOTOR_QC_HI) > 0 ? Number(process.env.MIRA_MOTOR_QC_HI) : 31.5;
    const qc = await run(py, [QC, videoPath, String(lo), String(hi)], { env, timeoutMs: 60_000 });
    const qcText = (qc.stdout + qc.stderr).slice(-500);
    if (qc.code !== 0) throw new Error(`QC kapısı geçilemedi: ${qcText.slice(-250)}`);
    const video = await fs.readFile(videoPath);
    const m = /sure=([\d.]+)/.exec(qcText);
    return {
      video,
      durationSeconds: m ? Number(m[1]) : null,
      qcOutput: qcText,
      renderMs: Date.now() - t0,
      pythonPath: py,
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
