import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contentAssets, contentItems, operations, tasks } from "@/db/schema";
import { like } from "drizzle-orm";
import { generateWithFallback } from "@/lib/model-manager";
import { generateNarration, type CaptionGroup } from "@/lib/narration";
import { generateImage } from "@/lib/generate-image";
import { renderShort, type RenderImage } from "@/lib/render-video";
import { extractNarration, parseDraftScript } from "@/lib/script-parse";
import { sendTelegramMessage } from "@/lib/telegram";

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

async function imagePromptsWithLlm(topic: string, script: string): Promise<string[]> {
  const result = await generateWithFallback({
    system: [
      "You are an image prompt writer for a Turkish YouTube Shorts channel.",
      "Write exactly 3 visual scene prompts for the given 20-second segment (beginning, middle, end).",
      "Each prompt: one cinematic vertical 9:16 scene, dark tones, neon green (#D4FF3F) accent, no text or lettering in the image.",
      "Prompts must be in English, 25-60 words each, safe for work, photorealistic or cinematic illustration.",
      'Return ONLY valid JSON: {"prompts": ["...", "...", "..."]}',
    ].join("\n"),
    history: [],
    message: `Topic: ${topic}\nScript excerpt:\n${script.slice(0, 1200)}`,
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

  // --- MOCK MODU: DB/Civitai/LLM olmadan pipeline'ın gerçek kod yollarını test eder ---
  if (body.mock === true) {
    try {
      const narrationText = typeof body.narrationText === "string" ? body.narrationText.trim() : "";
      const imageBase64 = Array.isArray(body.imageBase64) ? body.imageBase64 : [];
      if (!narrationText || imageBase64.length !== 3) {
        return NextResponse.json({ error: "mock modunda narrationText ve 3 imageBase64 gerekli" }, { status: 400 });
      }
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
    const narrationText = extractNarration(script, `${content.title}. ${topic}`);
    const sections = parseDraftScript(script);
    stages.script = { narrationChars: narrationText.length, sectionKeys: Object.keys(sections) };
    const checkpoints = await loadCheckpoints(content.id);
    await reportProgress(content.id, 15, "Senaryo ve önceki üretim kayıtları kontrol edildi");

    // 3) Görsel istemlerini kaydet; yeniden denemede aynı istemler kullanılır.
    let prompts = checkpoints.prompts;
    if (prompts.length !== 3) {
      try {
        prompts = await retryStage(content.id, "Görsel sahne planlama", 25, () => imagePromptsWithLlm(topic, script));
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

    // 4) Seslendirme: daha önce kaydedildiyse tekrar üretme.
    let narration: Awaited<ReturnType<typeof generateNarration>>;
    if (checkpoints.narrationAsset) {
      const meta = checkpoints.narrationAsset.meta && typeof checkpoints.narrationAsset.meta === "object"
        ? checkpoints.narrationAsset.meta as Record<string, unknown> : {};
      narration = {
        audio: Buffer.from(checkpoints.narrationAsset.data, "base64"),
        provider: typeof meta.provider === "string" ? meta.provider : "saved-audio",
        captions: Array.isArray(meta.captions) ? meta.captions as CaptionGroup[] : [],
        durationSeconds: typeof meta.durationSeconds === "number" ? meta.durationSeconds : null,
      };
      stages.tts = { provider: narration.provider, reused: true };
      await reportProgress(content.id, 50, "Kaydedilmiş seslendirme yeniden kullanılıyor");
    } else {
      await reportProgress(content.id, 40, "Seslendirme hazırlanıyor");
      narration = await retryStage(content.id, "Seslendirme", 40, () => generateNarration(narrationText));
      await db.insert(contentAssets).values({
        contentId: content.id,
        kind: "audio",
        mime: "audio/mpeg",
        data: Buffer.from(narration.audio).toString("base64"),
        bytes: narration.audio.length,
        meta: { pipelineStage: "narration", provider: narration.provider, captions: narration.captions, durationSeconds: narration.durationSeconds },
      });
      stages.tts = { provider: narration.provider, speechSeconds: narration.durationSeconds, checkpointSaved: true };
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
    const { video, durationSeconds, captionsUsed, profile } = await retryStage(content.id, "MP4 birleştirme", 82, () => renderShort({
      images,
      audio: Buffer.from(narration.audio),
      captions: narration.captions,
      narrationText,
      durationSeconds: narration.durationSeconds ?? undefined,
    }));
    stages.render = { durationSeconds, bytes: video.length, captions: captionsUsed, profile };

    await reportProgress(content.id, 93, "Video oluşturuldu; dosya kaydediliyor");

    // 7) Varlığı Postgres'e yaz, içeriği 'ready' yap (insan onayı öncesi)
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

    const baseUrl = (process.env.NEXT_PUBLIC_MIRA_BASE_URL || "https://aimira.up.railway.app").replace(/\/$/, "");
    const previewUrl = `${baseUrl}/api/video/asset/${asset.id}`;
    const telegram = await sendTelegramMessage(
      `✅ Mira video üretimini tamamladı\n\nBaşlık: ${content.title}\nİçerik ID: ${content.id}\nSüre: ${durationSeconds} sn\nDurum: Video hazır; YouTube'a otomatik yükleme bu bildirimin parçası değildir.\nÖnizleme: ${previewUrl}`
    );
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
    return NextResponse.json({ ok: false, produced: false, error: message.slice(0, 600), stages }, { status: 500 });
  }
}
