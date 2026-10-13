import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { logEvent } from "@/lib/logger";
import { contentAssets, contentItems, operations, tasks } from "@/db/schema";
import { isPermanentlyDeletedTopic } from "@/lib/deleted-topics";
import { like } from "drizzle-orm";
import { generateWithFallback } from "@/lib/model-manager";
import { generateNarration, type CaptionGroup } from "@/lib/narration";
import { generateImage } from "@/lib/generate-image";
import { renderShort, type RenderImage } from "@/lib/render-video";
import { renderWithMotor, buildMotorDesign, MotorQCFailError } from "@/lib/motor-render";
import { extractNarration, parseDraftScript, capNarrationForDuration } from "@/lib/script-parse";
import { sendTelegramMessage } from "@/lib/telegram";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return true;
  const hasEntryCookie = req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
  if (hasEntryCookie) return true;
  return !expected && process.env.NODE_ENV !== "production";
}

function decodeBase64Loose(value: string): Buffer {
  return Buffer.from(value.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, ""), "base64");
}

async function imagePromptsWithLlm(topic: string, script: string, narration: string): Promise<string[]> {
  const result = await generateWithFallback({
    system: [
      "You are an image prompt writer for a Turkish YouTube Shorts channel.",
      "The viewer sees 3 still images while the narration plays; each image MUST illustrate what is being said at that beat.",
      "Write exactly 3 visual scene prompts following the narration's progression (beginning, middle, end).",
      "Each prompt must depict a CONCRETE, physically representable subject directly tied to the narration: a person doing something, a recognizable object, a real place. If the narration mentions specifics (bank, money, vault, building, machine...), the scene must show those.",
      "FORBIDDEN: purely abstract/atmospheric scenes made only of light beams, gradients, glowing shapes, empty fog, or generic tech ambience.",
      "Each prompt: one cinematic vertical 9:16 scene, dark tones, neon green (#D4FF3F) accent, no text or lettering in the image.",
      "Prompts must be in English, 25-60 words each, safe for work, photorealistic or cinematic illustration.",
      'Return ONLY valid JSON: {"prompts": ["...", "...", "..."]}',
    ].join("\n"),
    history: [],
    message: `Topic: ${topic}\nNarration (Turkish - images must match its beats):\n${narration}\n\nScript excerpt:\n${script.slice(0, 900)}`,
  });
  const raw = result.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed: { prompts?: unknown } = JSON.parse(raw);
  if (!Array.isArray(parsed.prompts)) throw new Error("Model prompts listesi döndürmedi");
  const prompts = parsed.prompts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .slice(0, 3);
  if (prompts.length !== 3) throw new Error(`3 görsel promptu beklenirken ${prompts.length} geldi`);
  return prompts;
}

async function produceImages(prompts: string[], onImageReady?: (count: number) => Promise<void>) {
  const images: RenderImage[] = [];
  for (const prompt of prompts) {
    images.push(await generateImage(prompt));
    if (onImageReady) await onImageReady(images.length);
  }
  return images;
}

async function reportProgress(contentId: number, percentage: number, stage: string, status = "running") {
  try {
    await db.insert(operations).values({
      action: "content_produce_progress",
      summary: stage,
      status,
      metadata: { contentId, percentage, stage, updatedAt: new Date().toISOString() },
    });
  } catch (error) {
    console.error("[Produce] progress write failed:", error instanceof Error ? error.message : String(error));
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type FactGateResult = { ok: true; sourceUrls: string[]; reason: string } | { ok: false; sourceUrls: string[]; reason: string };

function isPublicHttpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname.includes(".")) return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return null;
    return url;
  } catch { return null; }
}

async function readPublicSource(raw: string): Promise<{ url: string; text: string }> {
  let current = isPublicHttpsUrl(raw);
  if (!current) throw new Error("Kaynak bağlantısı güvenli bir HTTPS adresi değil.");
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "MiraFactCheck/1.0" },
      cache: "no-store",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || hop === 3) throw new Error("Kaynak yönlendirmesi çözülemedi.");
      const next = isPublicHttpsUrl(new URL(location, current).toString());
      if (!next) throw new Error("Kaynak güvenli bir HTTPS adresine yönlendirmiyor.");
      current = next;
      continue;
    }
    if (!response.ok) throw new Error(`Kaynak bağlantısı HTTP ${response.status} döndürdü.`);
    const type = response.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new Error("Kaynak sayfası okunabilir metin olarak sunulmuyor.");
    const rawText = (await response.text()).slice(0, 250_000);
    const text = rawText
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ").trim();
    if (text.length < 250) throw new Error("Kaynak sayfasında doğrulama için yeterli metin bulunamadı.");
    return { url: current.toString(), text: text.slice(0, 12_000) };
  }
  throw new Error("Kaynak yönlendirmesi çözülemedi.");
}

async function verifyScriptSources(script: string, narration: string): Promise<FactGateResult> {
  const sections = parseDraftScript(script);
  const sourceSection = sections["KAYNAK"]?.trim() || "";
  if (!sourceSection || /DOĞRULAMA\s*GEREKLİ|KAYNAK\s*YOK|BİLİNMİYOR/i.test(sourceSection)) {
    return { ok: false, sourceUrls: [], reason: "Kaynak bölümü açıkça doğrulama gerektiğini belirtiyor veya boş." };
  }
  const candidates = [...sourceSection.matchAll(/https:\/\/[^\s)\]>]+/gi)]
    .map((match) => match[0].replace(/[.,;]+$/, ""))
    .filter((url, index, all) => all.indexOf(url) === index)
    .slice(0, 2);
  if (!candidates.length) return { ok: false, sourceUrls: [], reason: "Kaynak bölümünde kontrol edilebilir HTTPS bağlantısı yok." };
  try {
    const pages = await Promise.all(candidates.map(readPublicSource));
    const evidence = pages.map((page, index) => `KAYNAK ${index + 1}: ${page.url}\n${page.text}`).join("\n\n");
    const check = await generateWithFallback({
      system: [
        "Sen katı bir bilgi doğrulama denetçisisin. Yalnızca verilen kaynak metninde açıkça desteklenen iddiaları kabul et.",
        "Kaynakla çelişen, kaynakta bulunmayan, abartılmış veya kesinliği kanıtlanmamış ana iddia varsa reddet.",
        "Genel konu benzerliği yeterli değildir; seslendirmedeki ana olgular kaynak metniyle doğrudan desteklenmeli.",
        "Yalnızca geçerli JSON döndür: {\"supported\": true veya false, \"reason\": \"kısa Türkçe gerekçe\"}. Emin değilsen supported=false.",
      ].join("\n"),
      history: [],
      message: `VİDEO SESLENDİRMESİ:\n${narration}\n\nKAYNAK SAYFALARINDAN OKUNAN METİN:\n${evidence}`,
    });
    const raw = check.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(raw) as { supported?: unknown; reason?: unknown };
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 400) : "Model gerekçe vermedi.";
    if (parsed.supported !== true) return { ok: false, sourceUrls: pages.map((p) => p.url), reason };
    return { ok: true, sourceUrls: pages.map((p) => p.url), reason };
  } catch (error) {
    return { ok: false, sourceUrls: candidates, reason: (error instanceof Error ? error.message : String(error)).slice(0, 400) };
  }
}


const SILENT_THRESHOLD_DB = -45;

// MP3 buffer'ının ortalama ses seviyesini ölç (ffmpeg volumedetect). Ölcülemezse null.
async function measureMeanVolumeDb(mp3: Buffer | Uint8Array): Promise<number | null> {
  const bin = ffmpegPath;
  if (!bin) return null;
  return new Promise((resolve) => {
    const child = spawn(bin, ["-hide_banner", "-i", "pipe:0", "-af", "volumedetect", "-f", "null", "-"]);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { stderr = (stderr + c).slice(-4000); });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const m = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
      resolve(m ? Number(m[1]) : null);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(mp3);
  });
}

// TTS üret + ses gerçekten var mı diye doğrula; sessiz çıkarsa hata = retryStage yeniden dener.
async function generateAudibleNarration(text: string) {
  const narration = await generateNarration(text);
  const meanDb = await measureMeanVolumeDb(narration.audio);
  if (meanDb !== null && meanDb < SILENT_THRESHOLD_DB) {
    throw new Error(`Seslendirme sessiz üretildi (mean ${meanDb} dB); yeniden denenecek`);
  }
  return { narration, meanDb };
}

async function retryStage<T>(
  contentId: number,
  label: string,
  percentage: number,
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (attempt > 1) {
        await reportProgress(contentId, percentage, `${label}: ${attempt}. deneme başlıyor`, "retrying");
      }
      return await operation();
    } catch (error) {
      lastError = error;
      const detail = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) {
        await reportProgress(
          contentId,
          percentage,
          `${label} hatası: ${detail.slice(0, 180)} — otomatik düzeltme/yeniden deneme ${attempt}/${attempts - 1}`,
          "retrying",
        );
        await wait(1000 * attempt);
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  await reportProgress(contentId, percentage, `${label} başarısız: ${detail.slice(0, 220)} — görev silinmedi, kaldığı yerden devam etmek üzere beklemede`, "waiting");
  await logEvent({ level: "error", source: "produce/step", message: `Üretim adımı tutmadı #${contentId}: ${label} — ${detail.slice(0, 200)}`, meta: { contentId, label } });
  throw lastError instanceof Error ? lastError : new Error(detail);
}

async function loadCheckpoints(contentId: number) {
  const [checkpointOps, savedAssets] = await Promise.all([
    db.select().from(operations)
      .where(and(eq(operations.action, "content_produce_checkpoint"), eq(operations.status, "success")))
      .orderBy(desc(operations.id)).limit(100),
    db.select().from(contentAssets)
      .where(eq(contentAssets.contentId, contentId))
      .orderBy(contentAssets.id),
  ]);
  const checkpoint = checkpointOps.find((op) => {
    const meta = op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {};
    return Number(meta.contentId) === contentId && Array.isArray(meta.prompts);
  });
  const checkpointMeta = checkpoint?.metadata && typeof checkpoint.metadata === "object"
    ? checkpoint.metadata as Record<string, unknown> : {};
  const prompts = Array.isArray(checkpointMeta.prompts)
    ? checkpointMeta.prompts.filter((p): p is string => typeof p === "string") : [];
  const narrationAsset = [...savedAssets].reverse().find((asset) => {
    const meta = asset.meta && typeof asset.meta === "object" ? asset.meta as Record<string, unknown> : {};
    return asset.kind === "audio" && meta.pipelineStage === "narration";
  });
  const imageAssets = savedAssets.filter((asset) => {
    const meta = asset.meta && typeof asset.meta === "object" ? asset.meta as Record<string, unknown> : {};
    return asset.kind === "image" && meta.pipelineStage === "image";
  }).filter((asset) => {
    const meta = asset.meta as Record<string, unknown>;
    return Number.isInteger(Number(meta.imageIndex));
  }).sort((a, b) => Number((a.meta as Record<string, unknown>).imageIndex) - Number((b.meta as Record<string, unknown>).imageIndex));
  return { prompts, narrationAsset, imageAssets };
}

async function savePromptCheckpoint(contentId: number, prompts: string[]) {
  await db.insert(operations).values({
    action: "content_produce_checkpoint",
    summary: "Görsel istemleri kaydedildi",
    status: "success",
    metadata: { contentId, prompts, savedAt: new Date().toISOString() },
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "mira-content-producer",
    usage: {
      real: 'POST {"contentId": <id>} — onaylı taslak → TTS → 3 görsel → MP4 → content_assets',
      mock: 'POST {"mock": true, "narrationText": "...", "imageBase64": [...3 görsel...]} — DB/Civitai/LLM olmadan uçtan uca test',
    },
  });
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  void logEvent({ level: "info", source: "produce", message: "Üretim isteği alındı", meta: { contentId: (body as { contentId?: number })?.contentId ?? null } });

  // --- MOCK MODU: DB/Civitai/LLM olmadan pipeline'ın gerçek kod yollarını test eder ---
  if (body.mock === true) {
    try {
      const rawNarrationText = typeof body.narrationText === "string" ? body.narrationText.trim() : "";
      const imageBase64 = Array.isArray(body.imageBase64) ? body.imageBase64 : [];
      if (!rawNarrationText || imageBase64.length !== 3) {
        return NextResponse.json({ error: "mock modunda narrationText ve 3 imageBase64 gerekli" }, { status: 400 });
      }
      const narrationText = capNarrationForDuration(rawNarrationText).text;
      const t0 = Date.now();
      const narration = await generateNarration(narrationText);
      const tNarration = Date.now() - t0;
      const images: RenderImage[] = imageBase64.map((value: string, i: number) => {
        if (typeof value !== "string") throw new Error(`Görsel ${i + 1} base64 değil`);
        const bytes = decodeBase64Loose(value);
        return { bytes, extension: value.startsWith("data:image/png") ? "png" : "jpg" };
      });
      const t1 = Date.now();
      const { video, durationSeconds, captionsUsed } = await renderShort({
        images,
        audio: Buffer.from(narration.audio),
        captions: narration.captions as CaptionGroup[],
        narrationText,
        durationSeconds: narration.durationSeconds ?? undefined,
      });
      return NextResponse.json({
        ok: true,
        mock: true,
        tts: { provider: narration.provider, speechSeconds: narration.durationSeconds, ms: tNarration },
        captions: captionsUsed,
        render: { ms: Date.now() - t1, durationSeconds, bytes: video.length },
        videoBase64: video.toString("base64"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Produce/mock] failed:", message);
      await logEvent({ level: "error", source: "produce", message: `Mock üretim patladı: ${message.slice(0, 280)}` });
      return NextResponse.json({ ok: false, mock: true, error: message.slice(0, 600) }, { status: 500 });
    }
  }

  // --- GERÇEK AKIŞ ---
  const requestedId = Number(body.contentId);
  const hasId = Number.isInteger(requestedId) && requestedId > 0;
  const stages: Record<string, unknown> = {};

  try {
    // Önceki çalışmada video üretildi ama YouTube yüklemesi başarısız olduysa yeniden dene.
    const readyItems = await db.select().from(contentItems)
      .where(hasId
        ? and(eq(contentItems.id, requestedId), eq(contentItems.status, "ready"))
        : eq(contentItems.status, "ready"))
      .orderBy(contentItems.id)
      .limit(50);
    if (readyItems.length) {
      const approvalOps = await db.select().from(operations)
        .where(and(eq(operations.action, "content_approved"), eq(operations.status, "success")))
        .orderBy(desc(operations.id))
        .limit(500);
      const approvedIds = new Set(approvalOps
        .filter((op) => {
          const meta = op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {};
          return meta.approvedByUser === true && meta.videoRequested === true;
        })
        .map((op) => Number((op.metadata as Record<string, unknown>).contentId)));
      const readyApproved = readyItems.find((item) => approvedIds.has(item.id));
      if (readyApproved) {
        const [asset] = await db.select({ id: contentAssets.id }).from(contentAssets)
          .where(and(
            eq(contentAssets.contentId, readyApproved.id),
            eq(contentAssets.kind, "video"),
            eq(contentAssets.mime, "video/mp4"),
          ))
          .orderBy(desc(contentAssets.id))
          .limit(1);
        if (asset) {
          return NextResponse.json({
            ok: true,
            produced: true,
            alreadyProduced: true,
            contentId: readyApproved.id,
            assetId: asset.id,
            status: "ready",
            message: "Onaylı video hazır; YouTube yüklemesi yeniden denenebilir.",
          });
        }
      }
    }

    if (hasId) await reportProgress(requestedId, 5, "Onaylı içerik ve senaryo kontrol ediliyor");

    // 1) İçeriği bul: yalnızca kullanıcı tarafından onaylanmış içerik üretilebilir.
    const candidateRows = hasId
      ? await db.select().from(contentItems)
          .where(and(eq(contentItems.id, requestedId), eq(contentItems.status, "approved"))).limit(1)
      : await db.select().from(contentItems)
          .where(eq(contentItems.status, "approved")).orderBy(contentItems.id).limit(50);
    const approvalOpsForQueue = await db.select().from(operations)
      .where(and(eq(operations.action, "content_approved"), eq(operations.status, "success")))
      .orderBy(desc(operations.id)).limit(500);
    const videoApprovedIds = new Set(approvalOpsForQueue
      .filter((op) => {
        const meta = op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {};
        return meta.approvedByUser === true && meta.videoRequested === true;
      })
      .map((op) => Number((op.metadata as Record<string, unknown>).contentId)));
    const content = candidateRows.find((item) => videoApprovedIds.has(item.id));
    if (!content) {
      return NextResponse.json({ ok: true, produced: false, message: "Video üretimi için onaylanmış içerik yok." });
    }
    const requestedTopic = content.topic?.trim() || content.title;
    if (await isPermanentlyDeletedTopic(db, [content.title, requestedTopic])) {
      return NextResponse.json({ ok: true, produced: false, permanentlyBlocked: true, message: "Bu konu kalıcı olarak silindi; video üretimi engellendi." }, { status: 410 });
    }

    // 2) Senaryo metni ve kalıcı ara kayıtlar
    const draftOps = await db.select().from(operations)
      .where(and(eq(operations.action, "autonomous_content_draft"), eq(operations.status, "success")))
      .orderBy(desc(operations.id)).limit(200);
    const script = draftOps
      .map((op) => (op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {}))
      .find((meta) => Number(meta.contentId) === content.id && typeof meta.script === "string")?.script;
    if (typeof script !== "string" || !script.trim()) {
      return NextResponse.json({ ok: true, produced: false, message: "Taslak senaryosu bulunamadı; görev korunuyor ve tekrar denenebilir.", contentId: content.id });
    }
    const topic = content.topic?.trim() || content.title;
    if (await isPermanentlyDeletedTopic(db, [content.title, topic])) {
      return NextResponse.json({ ok: true, produced: false, permanentlyBlocked: true, message: "Bu konu kalıcı olarak silindi; video üretimi engellendi." }, { status: 410 });
    }
    const rawNarration = extractNarration(script, `${content.title}. ${topic}`);
    const narrationCap = capNarrationForDuration(rawNarration);
    let narrationText = narrationCap.text;
    const sections = parseDraftScript(script);

    // Kapı KARARI tek yerde: işçinin `autonomous_content_draft` kaydı (factCheck bloğu).
    // Bu rotanın kendi bıraktığı "fact_check_*" damgaları YANKIDIR — karar değildir
    // (aksi halde sistem ilk blok damgasını okuyup kendini sonsuz loop'a sokar).
    const priorDraftOps = await db.select().from(operations).where(eq(operations.action, "autonomous_content_draft")).orderBy(desc(operations.id)).limit(500);
    const priorDraft = priorDraftOps.find((op) => { const meta = op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {}; return Number(meta.contentId) === content.id && op.status !== "failed"; });
    const draftMeta = priorDraft?.metadata && typeof priorDraft.metadata === "object" ? priorDraft.metadata as Record<string, unknown> : {};
    const draftFact = draftMeta.factCheck && typeof draftMeta.factCheck === "object" ? draftMeta.factCheck as Record<string, unknown> : {};
    // TAZE KARAR = factCheck alanları VARSA. Kapı-öncesi dönemde yazılan taslakların
    // factCheck bloğu yoktur → o taslaklara "blok" muamelesi YAPILMAZ (doğrulama hiç koşmamıştır;
    // kullanıcı panelden onayladıysa üretim yürür).
    const hasDraftVerdict = typeof draftFact.ok === "boolean" || typeof draftFact.manualGrace === "boolean";
    const draftOk = draftFact.ok === true;
    const manualGrace = draftFact.manualGrace === true;
    const gateEffective = !hasDraftVerdict || draftOk || manualGrace;
    const gateMode = hasDraftVerdict
      ? draftOk ? "işçi: doğrulandı" : manualGrace ? "işçi: manuel koruma" : "işçi: BLOK (otomatik akış)"
      : "işçi: doğrulama öncesi taslak (panel onayı)";
    const gateReason = typeof draftFact.reason === "string" && draftFact.reason
      ? draftFact.reason
      : "Senaryo aşamasında kaynak kontrolü kaydı yok.";
    const gateSources = Array.isArray(draftFact.sourceUrls) ? draftFact.sourceUrls.filter((u): u is string => typeof u === "string") : [];
    // Yankı damgası: karar değildir, analiz amaçlı iz'dir (sonraki çağrılar bunu YOK sayar).
    await db.insert(operations).values({
      action: "fact_check_echo",
      summary: `Produce kapısı ${gateEffective ? "yeşil yaktı" : "engelledi"} (${gateMode}): ${content.title}`,
      status: gateEffective ? "success" : "failed",
      platform: content.platform,
      metadata: { contentId: content.id, sourceUrls: gateSources, reason: gateReason, gate: "produce_voice_relay", gateMode, manualGrace, hadDraftVerdict: hasDraftVerdict, videoCreated: false },
    });
    if (!gateEffective) {
      await reportProgress(content.id, 8, `❌ Doğruluğu ispatlanamadı, video oluşturulamıyor. ${gateReason}`, "waiting");
      await logEvent({ level: "error", source: "produce/gate", message: `Video kapıda durdu (otomatik akışın blok kararı) #${content.id}: ${gateReason.slice(0, 280)}`, meta: { contentId: content.id, title: content.title, gateMode } });
      return NextResponse.json({
        ok: true, produced: false, blocked: true, contentId: content.id,
        error: "❌ Doğruluğu ispatlanamadı, video oluşturulamıyor.",
        reason: gateReason, sourceUrls: gateSources, gateMode,
      }, { status: 200 });
    }
    if (gateMode !== "işçi: doğrulandı") {
      await reportProgress(content.id, 8, `⚠️ Kaynak kontrolü sınırlı (${gateMode}); üretim kullanıcı onayıyla sürüyor…`, "running");
      await logEvent({ level: "warn", source: "produce/gate", message: `Kapı uyardı ama engellemedi #${content.id} — ${gateMode}: ${gateReason.slice(0, 220)}`, meta: { contentId: content.id, gateMode } });
    } else {
      await logEvent({ level: "info", source: "produce/gate", message: `Kaynak kontrolü doğrulandı, üretime geçiliyor #${content.id}`, meta: { contentId: content.id } });
    }
    stages.factCheck = { ok: gateEffective, gateMode, sourceUrls: gateSources, reason: gateReason };

    stages.script = { narrationChars: rawNarration.length, narrationWords: narrationCap.words, wasCapped: narrationCap.wasCapped, sectionKeys: Object.keys(sections) };

    // Anlatı çok kısaysa (<32 kelime ≈ <15sn) üretim anında bir kez uzat:
    // modelin 40-48 kelime şartını tutmadığı eski taslaklar için de çalışır.
    if (narrationCap.words > 0 && narrationCap.words < 32) {
      try {
        const expanded = await retryStage(content.id, "Kısa anlatı uzatma", 12, async () => {
          const r = await generateWithFallback({
            system: [
              "Türkçe bir YouTube Shorts anlatı yazıcısısın.",
              "Verilen kısa anlatıyı aynı konuda tutarak 44-56 kelimeye uzat: ilk cümledeki kancayı koru, konuyla ilgili 1-2 somut ve doğrulanabilir bilgi ekle, otoriter ve doğal bir üslupla bitir.",
              "Sadece anlatı metnini döndür; başlık, süre bilgisi, köşeli açıklama, alıntı, yıldız işareti EKLEME.",
            ].join("\n"),
            history: [],
            message: `Konu: ${topic}\nKısa anlatı (${narrationCap.words} kelime):\n${narrationText}`,
          });
          const text = r.content.replace(/\s+/g, " ").trim();
          const words = text.split(/\s+/).filter(Boolean).length;
          if (words < 30 || words > 90) throw new Error(`Uzatılan anlatı makul uzunlukta değil (${words} kelime)`);
          return text;
        });
        const recap = capNarrationForDuration(expanded);
        const before = narrationCap.words;
        narrationText = recap.text;
        stages.script = { ...(stages.script as Record<string, unknown>), narrationWords: recap.words, expandedFromWords: before };
      } catch (error) {
        stages.script = { ...(stages.script as Record<string, unknown>), expandSkipped: (error instanceof Error ? error.message : String(error)).slice(0, 150) };
      }
    }

    // Sabit marka CTA'sı: marka motorunun altyazı hizalaması VO ile birebir aynı metni ister.
    const MOTOR_CTA = "Daha fazla bilgi dozu için takip etmeyi unutma!";
    if (!/unutma!?$/i.test(narrationText.trim())) {
      narrationText = `${narrationText.trim()} ${MOTOR_CTA}`;
      stages.script = { ...(stages.script as Record<string, unknown>), narrationWords: narrationText.split(/\s+/).filter(Boolean).length, ctaAppended: true };
    }
    const checkpoints = await loadCheckpoints(content.id);
    await reportProgress(content.id, 15, "Senaryo ve önceki üretim kayıtları kontrol edildi");

    // 3) Görsel istemlerini kaydet; yeniden denemede aynı istemler kullanılır.
    let prompts = checkpoints.prompts;
    if (prompts.length !== 3) {
      try {
        prompts = await retryStage(content.id, "Görsel sahne planlama", 25, () => imagePromptsWithLlm(topic, script, narrationText));
        stages.prompts = { source: "llm" };
      } catch (error) {
        const fallback = (sections["GÖRSEL TASARIMI"] || topic)
          .split(/\n|\.|;/).map((s) => s.trim()).filter((s) => s.length > 12).slice(0, 3);
        prompts = [
          `Cinematic vertical scene about ${topic}, dark tones, neon green accent, no text`,
          fallback[0] || `Close-up cinematic detail related to ${topic}, moody lighting, no text`,
          fallback[1] || `Wide cinematic establishing shot related to ${topic}, dark tones, no text`,
        ];
        stages.prompts = { source: "fallback", llmError: String(error).slice(0, 200) };
      }
      await savePromptCheckpoint(content.id, prompts);
    } else {
      stages.prompts = { source: "saved-checkpoint", reused: true };
      await reportProgress(content.id, 30, "Önceden kaydedilmiş görsel planı yeniden kullanılıyor");
    }

    await reportProgress(content.id, 30, "Görsel sahneler planlandı");

    // 4) Seslendirme: daha önce kaydedildiyse tekrar üretme — AMA checkpoint sessizse
    // (veya 30sn kuralından önce üretilmiş uzun sürümse) bayat say, tazele.
    let narration: Awaited<ReturnType<typeof generateNarration>> | null = null;
    let narrationMeanDb: number | null = null;
    let checkpointStaleReason = "";
    if (checkpoints.narrationAsset) {
      const meta = checkpoints.narrationAsset.meta && typeof checkpoints.narrationAsset.meta === "object"
        ? checkpoints.narrationAsset.meta as Record<string, unknown> : {};
      const savedSeconds = typeof meta.durationSeconds === "number" ? meta.durationSeconds : null;
      if (savedSeconds !== null && savedSeconds > 34) {
        checkpointStaleReason = `kaydedilmiş ses ${savedSeconds}sn (30sn kuralından önce üretilmiş)`;
      } else if (meta.ctaVersion !== 1) {
        checkpointStaleReason = "CTA'sız eski ses (marka motoru eşleşmesi için yeniden üretilecek)";
      } else {
        const audio = Buffer.from(checkpoints.narrationAsset.data, "base64");
        narrationMeanDb = await measureMeanVolumeDb(audio);
        if (narrationMeanDb !== null && narrationMeanDb < SILENT_THRESHOLD_DB) {
          checkpointStaleReason = `kaydedilmiş ses sessiz (mean ${narrationMeanDb} dB)`;
        } else {
          narration = {
            audio,
            provider: typeof meta.provider === "string" ? meta.provider : "saved-audio",
            captions: Array.isArray(meta.captions) ? meta.captions as CaptionGroup[] : [],
            durationSeconds: savedSeconds,
          };
          stages.tts = { provider: narration.provider, reused: true, meanVolumeDb: narrationMeanDb };
          await reportProgress(content.id, 50, "Kaydedilmiş seslendirme yeniden kullanılıyor");
        }
      }
    }
    if (!narration) {
      await reportProgress(content.id, 40,
        checkpointStaleReason ? `Seslendirme hazırlanıyor (${checkpointStaleReason}; yeniden üretilecek)` : "Seslendirme hazırlanıyor");
      const fresh = await retryStage(content.id, "Seslendirme", 40, () => generateAudibleNarration(narrationText));
      narration = fresh.narration;
      narrationMeanDb = fresh.meanDb;
      if (await isPermanentlyDeletedTopic(db, [content.title, topic])) {
        return NextResponse.json({ ok: true, produced: false, permanentlyBlocked: true, message: "Silme isteği sırasında konu kalıcı olarak silindi; medya kaydı durduruldu." }, { status: 410 });
      }
      await db.insert(contentAssets).values({
        contentId: content.id,
        kind: "audio",
        mime: "audio/mpeg",
        data: Buffer.from(narration.audio).toString("base64"),
        bytes: narration.audio.length,
        meta: { pipelineStage: "narration", provider: narration.provider, captions: narration.captions, durationSeconds: narration.durationSeconds, ctaVersion: 1 },
      });
      stages.tts = { provider: narration.provider, speechSeconds: narration.durationSeconds, checkpointSaved: true, meanVolumeDb: narrationMeanDb, regeneratedFromCheckpoint: Boolean(checkpointStaleReason) };
      await reportProgress(content.id, 50, "Seslendirme tamamlandı; görseller hazırlanıyor");
    }

    // 5) Görselleri tek tek üretip hemen kalıcı kaydet; hata olursa hazır görseller kaybolmaz.
    const images: RenderImage[] = [];
    for (let i = 0; i < 3; i++) {
      const existing = checkpoints.imageAssets.find((asset) => Number((asset.meta as Record<string, unknown>).imageIndex) === i);
      if (existing) {
        images.push({ bytes: Buffer.from(existing.data, "base64"), extension: existing.mime.includes("png") ? "png" : existing.mime.includes("webp") ? "webp" : "jpg" });
        await reportProgress(content.id, [60, 70, 78][i], `Kaydedilmiş ${i + 1}/3 görsel yeniden kullanılıyor`);
        continue;
      }
      const image = await retryStage(content.id, `${i + 1}. görsel üretimi`, [60, 70, 78][i], async () => {
        return generateImage(prompts[i]);
      });
      images.push(image);
      if (await isPermanentlyDeletedTopic(db, [content.title, topic])) {
        return NextResponse.json({ ok: true, produced: false, permanentlyBlocked: true, message: "Silme isteği sırasında konu kalıcı olarak silindi; medya kaydı durduruldu." }, { status: 410 });
      }
      await db.insert(contentAssets).values({
        contentId: content.id,
        kind: "image",
        mime: image.extension === "png" ? "image/png" : image.extension === "webp" ? "image/webp" : "image/jpeg",
        data: image.bytes.toString("base64"),
        bytes: image.bytes.length,
        meta: { pipelineStage: "image", imageIndex: i, prompt: prompts[i], provider: image.provider },
      });
      await reportProgress(content.id, [60, 70, 78][i], `${i + 1}/3 görsel hazırlandı ve kaydedildi (${image.provider})`);
    }
    stages.images = { count: images.length, bytes: images.map((i) => i.bytes.length), resumed: checkpoints.imageAssets.length > 0 };

    // 6) MP4 render
    await reportProgress(content.id, 82, "Görseller tamamlandı; MP4 video oluşturuluyor");
    // 6) Render: yalnızca belirtilen marka şablonu kullanılabilir.
    // Şablon motoru kapalıysa veya hata verirse alternatif renderer kesinlikle çalıştırılmaz.
    if (process.env.MIRA_USE_PY_MOTOR === "0") {
      throw new Error("Belirtilen video şablonu devre dışı (MIRA_USE_PY_MOTOR=0). Bu işlem gerçekleştirilmedi.");
    }
    await reportProgress(content.id, 82, "Video birleştiriliyor (marka motoru)");
    const motorDesign = buildMotorDesign({
      designSection: sections["TASARIM"],
      title: content.title, topic, narration: narrationText, sections,
    });
    let video: Buffer;
    let durationSeconds: number | null;
    let captionsUsed = 0;
    let profile = "";
    if (process.env.MIRA_USE_PY_MOTOR !== "0") {
      try {
        const motor = await retryStage(content.id, "Marka motoru render", 84, () => renderWithMotor({
          contentId: content.id,
          narrationText,
          audioMp3: narration.audio,
          images,
          design: motorDesign,
        }));
        video = motor.video;
        durationSeconds = motor.durationSeconds;
        profile = `motor-${process.env.MIRA_MOTOR_W || "720"}x${process.env.MIRA_MOTOR_H || "1280"}`;
        stages.render = { engine: "python-motor", durationSeconds, bytes: video.length, renderMs: motor.renderMs, qc: motor.qcOutput.slice(-220), profile };
      } catch (motorError) {
        const msg = motorError instanceof Error ? motorError.message : String(motorError);
        // QC FAIL = kalite kararı: yedeğe düşülmez, görev FAILED olur, publish asla başlamaz.
        if (motorError instanceof MotorQCFailError) {
          stages.render = { engine: "python-motor", qcFailed: true, qc: msg.slice(-220) };
          await db.update(contentItems).set({ status: "failed", updatedAt: new Date() })
            .where(eq(contentItems.id, content.id));
          await db.update(tasks).set({ status: "failed", updatedAt: new Date() })
            .where(like(tasks.notes, `%\"contentId\":${content.id}%`));
          await db.insert(operations).values({
            action: "content_produce",
            summary: `Motor QC kapısından geçemedi; otomatik red — video artifaktı oluşmadan kapatıldı: ${content.title}`,
            status: "failed",
            platform: content.platform,
            metadata: { contentId: content.id, qc: msg.slice(-700), stages, qcFailed: true, autoRejected: true },
          }).catch(() => {});
          await sendTelegramMessage(
            `❌ Mira marka motoru QC kapısından geçemedi — video OTOMATİK RED\n\nBaşlık: ${content.title}\nİçerik ID: ${content.id}\nQC: ${msg.slice(-400)}\n\nKural gereği yedek/yansi render çalıştırılmadı; yayın adımı hiç başlamadı. İyileştirmeler genellikle: gerçek TTS sesiyle LRA bandı aşılır.`
          ).catch(() => {});
          void logEvent({ level: "error", source: "produce/qc", message: `QC FAIL — video reddedildi #${content.id}: ${msg.slice(0, 280)}`, meta: { contentId: content.id, http: 422 } });
          return NextResponse.json({ ok: false, produced: false, qcFailed: true, error: msg.slice(0, 600), stages }, { status: 422 });
        }
        const reason = /şablon|tasarım bloğu/i.test(msg)
          ? msg
          : `Belirtilen video şablonu çalıştırılamadı (${msg.slice(0, 240)}). Bu işlemi gerçekleştirmiyorum; alternatif tasarımla video üretilmedi.`;
        console.error(`[Produce] Şablon motoru başarısız (#${content.id}): ${reason.slice(0, 300)}`);
        stages.render = { engine: "python-motor", templateFailed: true, error: reason.slice(0, 500) };
        await db.update(contentItems).set({ status: "failed", updatedAt: new Date() })
          .where(eq(contentItems.id, content.id));
        await db.update(tasks).set({ status: "failed", updatedAt: new Date() })
          .where(like(tasks.notes, `%"contentId":${content.id}%`));
        await db.insert(operations).values({
          action: "content_produce",
          summary: `Belirtilen video şablonu bulunamadı/çalışmadı; üretim durduruldu: ${content.title}`,
          status: "failed",
          platform: content.platform,
          metadata: { contentId: content.id, templateFailed: true, error: reason.slice(0, 700), stages },
        }).catch(() => {});
        await sendTelegramMessage(
          `⛔ Mira video üretimini durdurdu\n\nBelirtilen şablon bulunamadı veya çalıştırılamadı. Bu işlemi gerçekleştirmiyorum.\n\nBaşlık: ${content.title}\nİçerik ID: ${content.id}\nNeden: ${reason.slice(0, 400)}\n\nAlternatif tasarımla video üretilmedi ve yayın adımı başlatılmadı.`
        ).catch(() => {});
        void logEvent({ level: "error", source: "produce/template", message: `Şablon bulunamadı/çalışmadı; üretim durduruldu #${content.id}: ${reason.slice(0, 240)}`, meta: { contentId: content.id, http: 422 } });
        return NextResponse.json({ ok: false, produced: false, templateFailed: true, error: reason.slice(0, 600), stages }, { status: 422 });
      }
    } else {
      const rs = await retryStage(content.id, "MP4 birleştirme", 82, () => renderShort({
        images,
        audio: Buffer.from(narration.audio),
        captions: narration.captions,
        narrationText,
        durationSeconds: narration.durationSeconds ?? undefined,
      }));
      video = rs.video;
      durationSeconds = rs.durationSeconds;
      captionsUsed = rs.captionsUsed;
      profile = rs.profile;
      stages.render = { engine: "ts-ladder", durationSeconds, bytes: video.length, captions: captionsUsed, profile };
    }

    await reportProgress(content.id, 93, "Video oluşturuldu; dosya kaydediliyor");

    // 7) Varlığı Postgres'e yaz, içeriği 'ready' yap (insan onayı öncesi)
    if (await isPermanentlyDeletedTopic(db, [content.title, topic])) {
      return NextResponse.json({ ok: true, produced: false, permanentlyBlocked: true, message: "Silme isteği sırasında konu kalıcı olarak silindi; medya kaydı durduruldu." }, { status: 410 });
    }
    const [asset] = await db.insert(contentAssets).values({
      contentId: content.id,
      kind: "video",
      mime: "video/mp4",
      data: video.toString("base64"),
      bytes: video.length,
      meta: { durationSeconds, captions: captionsUsed, ttsProvider: narration.provider, prompts },
    }).returning({ id: contentAssets.id });

    const [updated] = await db.update(contentItems)
      .set({ status: "ready", updatedAt: new Date() })
      .where(eq(contentItems.id, content.id)).returning();

    await db.insert(operations).values({
      action: "content_produce",
      summary: `Video üretildi (onay bekliyor): ${content.title}`,
      status: "success",
      platform: content.platform,
      metadata: { contentId: content.id, assetId: asset.id, stages },
    });

    await db.update(tasks)
      .set({ status: "done", updatedAt: new Date() })
      .where(like(tasks.notes, `%"contentId":${content.id}%`));

    // Video artık güvenle kaydedildi: büyük ara dosyaları veritabanında tutma.
    // MP4 inceleme/onay ve YouTube yüklemesi için korunur.
    try {
      await db.delete(contentAssets).where(and(eq(contentAssets.contentId, content.id), eq(contentAssets.kind, "audio")));
      await db.delete(contentAssets).where(and(eq(contentAssets.contentId, content.id), eq(contentAssets.kind, "image")));
      stages.cleanup = { intermediateAudioAndImagesDeleted: true };
      console.log(`[Produce] içerik #${content.id}: ara ses/görsel varlıkları temizlendi; MP4 korundu`);
    } catch (cleanupError) {
      stages.cleanup = { intermediateAudioAndImagesDeleted: false };
      console.warn(`[Produce] içerik #${content.id}: ara varlık temizliği başarısız:`, cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }

    const baseUrl = (process.env.NEXT_PUBLIC_MIRA_BASE_URL || "https://aimira.up.railway.app").replace(/\/$/, "");
    const previewUrl = `${baseUrl}/api/video/asset/${asset.id}`;
    const telegram = await sendTelegramMessage(
      `✅ Mira video üretimini tamamladı\n\nBaşlık: ${content.title}\nİçerik ID: ${content.id}\nSüre: ${durationSeconds} sn\nDurum: Video hazır; YouTube'a otomatik yükleme bu bildirimin parçası değildir.\nÖnizleme: ${previewUrl}`
    );
    await logEvent({ level: "success", source: "produce/done", message: `Video hazır #${content.id} — "${content.title}" (${durationSeconds} sn)`, meta: { contentId: content.id, previewUrl, durationSeconds } });
    stages.telegram = telegram;
    await reportProgress(content.id, 100, "Video hazır", "success");

    return NextResponse.json({
      ok: true,
      produced: true,
      contentId: content.id,
      assetId: asset.id,
      status: updated.status,
      previewPath: `/api/video/asset/${asset.id}`,
      telegram,
      stages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Produce] failed:", message);
    if (hasId) {
      // Görev iptal edilmez: onaylı kalır ve kaydedilmiş ara çıktılar sonraki denemede kullanılır.
      await reportProgress(requestedId, 0, `Hata kaydedildi: ${message.slice(0, 240)} — görev beklemede, tekrar denenebilir`, "waiting");
      await db.insert(operations).values({
        action: "content_produce",
        summary: `Video üretimi geçici olarak beklemede; yeniden denenebilir`,
        status: "retryable",
        metadata: { contentId: requestedId, error: message.slice(0, 1500), stages, retryable: true, checkpointsPreserved: true },
      }).catch(() => {});
      const [failedContent] = await db.select({ title: contentItems.title }).from(contentItems)
        .where(eq(contentItems.id, requestedId)).limit(1).catch(() => []);
      await sendTelegramMessage(
        `⚠️ Mira video üretiminde bir engelle karşılaştı\n\nBaşlık: ${failedContent?.title || "İçerik #" + requestedId}\nHata: ${message.slice(0, 700)}\nDurum: Görev iptal edilmedi. Kaydedilmiş aşamalar korunuyor; aynı contentId ile yeniden başlatıldığında kaldığı yerden devam etmeyi deneyecek.`
      ).catch(() => ({ sent: false as const, reason: "send_failed" as const }));
    }
    await logEvent({ level: "error", source: "produce", message: `Üretim patladı${hasId ? ` #${requestedId}` : ""}: ${message.slice(0, 300)}`, meta: { contentId: hasId ? requestedId : null, retryable: true } });
    return NextResponse.json({ ok: false, produced: false, error: message.slice(0, 600), stages }, { status: 500 });
  }
}
