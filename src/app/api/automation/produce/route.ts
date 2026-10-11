import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contentAssets, contentItems, operations, tasks } from "@/db/schema";
import { like } from "drizzle-orm";
import { generateWithFallback } from "@/lib/model-manager";
import { generateNarration, type CaptionGroup } from "@/lib/narration";
import { generateCivitaiImage } from "@/lib/civitai";
import { renderShort, type RenderImage } from "@/lib/render-video";
import { extractNarration, parseDraftScript } from "@/lib/script-parse";
import { sendTelegramMessage } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  return req.headers.get("x-mira-key") === expected;
}

function decodeBase64Loose(value: string): Buffer {
  return Buffer.from(value.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, ""), "base64");
}

// Civitai orchestration yanıtının derinlerindeki görsel URL'lerini topla
function collectImageUrls(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (/^https?:\/\/\S+$/.test(value) && /\.(jpe?g|png|webp)(\?\S*)?$/i.test(value)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectImageUrls(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectImageUrls(item, found);
  }
  return [...new Set(found)];
}

async function downloadImage(url: string): Promise<RenderImage> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(40_000),
    headers: { "User-Agent": "MiraContentPipeline/1.0" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Görsel indirilemedi HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error(`Görsel beklenirken ${type || "bilinmeyen tip"} geldi`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error("Görsel boş veya çok büyük");
  const extension = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  return { bytes: buffer, extension };
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

async function produceImages(prompts: string[]) {
  const images: RenderImage[] = [];
  for (const prompt of prompts) {
    const result = await generateCivitaiImage({ prompt, aspectRatio: "9:16", size: "medium" });
    const urls = collectImageUrls(result);
    if (!urls.length) throw new Error("Civitai görsel URL'si döndürmedi");
    images.push(await downloadImage(urls[0]));
  }
  return images;
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

    // 2) Senaryo metnini al
    const draftOps = await db.select().from(operations)
      .where(and(eq(operations.action, "autonomous_content_draft"), eq(operations.status, "success")))
      .orderBy(desc(operations.id)).limit(200);
    const script = draftOps
      .map((op) => (op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {}))
      .find((meta) => Number(meta.contentId) === content.id && typeof meta.script === "string")?.script;
    if (typeof script !== "string" || !script.trim()) {
      return NextResponse.json({ ok: true, produced: false, message: "Taslak senaryosu bulunamadı (worker çalışmadı mı?).", contentId: content.id });
    }
    const topic = content.topic?.trim() || content.title;
    const narrationText = extractNarration(script, `${content.title}. ${topic}`);
    const sections = parseDraftScript(script);
    stages.script = { narrationChars: narrationText.length, sectionKeys: Object.keys(sections) };

    // 3) 3 görsel promptu (LLM; başarısızsa görsel tasarım bölümünden degrade)
    let prompts: string[];
    try {
      prompts = await imagePromptsWithLlm(topic, script);
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

    // 4) Seslendirme + senkron altyazı
    const narration = await generateNarration(narrationText);
    stages.tts = { provider: narration.provider, speechSeconds: narration.durationSeconds };

    // 5) Civitai ile 3 görsel
    const images = await produceImages(prompts);
    stages.images = { count: images.length, bytes: images.map((i) => i.bytes.length) };

    // 6) MP4 render
    const { video, durationSeconds, captionsUsed } = await renderShort({
      images,
      audio: Buffer.from(narration.audio),
      captions: narration.captions,
      narrationText,
      durationSeconds: narration.durationSeconds ?? undefined,
    });
    stages.render = { durationSeconds, bytes: video.length, captions: captionsUsed };

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
      // Hata durumunda içerik 'approved' kalır (tekrar denenebilir); işlem kayıtlarına yaz.
      await db.insert(operations).values({
        action: "content_produce",
        summary: `Video üretimi başarısız oldu`,
        status: "failed",
        metadata: { contentId: requestedId, error: message.slice(0, 1500), stages },
      }).catch(() => {});
      const [failedContent] = await db.select({ title: contentItems.title }).from(contentItems)
        .where(eq(contentItems.id, requestedId)).limit(1).catch(() => []);
      await sendTelegramMessage(
        `❌ Mira video üretimini tamamlayamadı\n\nBaşlık: ${failedContent?.title || "İçerik #" + requestedId}\nHata: ${message.slice(0, 1000)}\nDurum: İçerik tekrar denenmek üzere onaylı bırakıldı.`
      ).catch(() => ({ sent: false as const, reason: "send_failed" as const }));
    }
    return NextResponse.json({ ok: false, produced: false, error: message.slice(0, 600), stages }, { status: 500 });
  }
}
