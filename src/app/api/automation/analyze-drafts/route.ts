import { isMiraSessionCookie } from "@/lib/mira-auth";
import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { contentAssets, contentItems, operations } from "@/db/schema";
import { generateWithFallback } from "@/lib/model-manager";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request) {
  const hasEntryCookie = isMiraSessionCookie(req.headers.get("cookie"));
  if (hasEntryCookie) return true;
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  return req.headers.get("x-mira-key") === expected;
}

function metadataOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  }

  const drafts = await db.select().from(contentItems)
    .where(eq(contentItems.status, "draft"))
    .orderBy(desc(contentItems.updatedAt))
    .limit(50);

  if (drafts.length === 0) {
    return NextResponse.json({ ok: true, analyzed: false, count: 0, message: "Analiz edilecek taslak yok." });
  }

  const ids = drafts.map((draft) => draft.id);
  const [draftOps, analysisOps] = await Promise.all([
    db.select().from(operations)
      .where(and(eq(operations.action, "autonomous_content_draft"), inArray(operations.status, ["success", "failed"])))
      .orderBy(desc(operations.id))
      .limit(500),
    db.select().from(operations)
      .where(eq(operations.action, "content_draft_analysis"))
      .orderBy(desc(operations.id))
      .limit(200),
  ]);

  const latestScriptById = new Map<number, string>();
  for (const op of draftOps) {
    const meta = metadataOf(op.metadata);
    const id = Number(meta.contentId);
    if (ids.includes(id) && typeof meta.script === "string" && !latestScriptById.has(id)) {
      latestScriptById.set(id, meta.script);
    }
  }

  const alreadyAnalyzed = new Set<number>();
  for (const op of analysisOps) {
    const meta = metadataOf(op.metadata);
    if (Array.isArray(meta.analyzedContentIds)) {
      for (const id of meta.analyzedContentIds) {
        const parsedId = Number(id);
        if (Number.isInteger(parsedId) && parsedId > 0) alreadyAnalyzed.add(parsedId);
      }
    }
  }

  const pending = drafts
    .filter((draft) => !alreadyAnalyzed.has(draft.id) && latestScriptById.has(draft.id))
    .map((draft) => ({
      id: draft.id,
      title: draft.title,
      topic: draft.topic,
      createdAt: draft.createdAt,
      script: latestScriptById.get(draft.id),
    }));

  if (pending.length === 0) {
    return NextResponse.json({
      ok: true,
      analyzed: false,
      count: 0,
      draftsFound: drafts.length,
      message: "Yeni analiz bekleyen taslak yok veya taslakların metinleri bulunamadı.",
    });
  }

  const result = await generateWithFallback({
    system: [
      "Sen Mira'nın YouTube Shorts editörü ve içerik seçicisisin.",
      "Her içeriği 100 üzerinden puanla: kanca 25, tek ve anlaşılır bilgi 25, kaynak/kanıt 15, süreye uygunluk 15, özgünlük 10, görselleştirilebilirlik 10. Kaynak uydurma; uydurma kaynak/URL = REJECT sebebi.",
      "KAYNAK bölümünde 'DOĞRULAMA GEREKLİ' yazması kanıt uydurma DEĞİLDİR — model web araması yapamaz; bu durumda kaynak puanını düşür ama doğrulanabilir-markalı metnin geri kalanı iyiyse KEEP adayı olabilir. Bilgi gerçekten mantıklı/öğreticiyse ve DOĞRULAMA GEREKLİ ise: puanı 60-70 bandında tut, kanca+bilgi kalitesine göre verdiğin nihai kararda sileceğin değil arşivleneceğini unutma.",
      "En iyi en fazla 3 içeriği KEEP seç; KEEP için puan en az 60 olmalı. Geri kalanların tamamını REJECT seç. KEEP olanlar Taslaklar bölümünde kalacak, REJECT olanlar SİLİNMEZ — 'rejected' durumuna alınır (arşiv; panelde görülebilir, kullanıcı isterse kurtarır). Yalnızca marka-dışı, uydurma-kaynaklı, kanıtsız-abartılı veya aynen tekrarlananları REJECT için hedefle.",
      "Yalnızca verilen id'leri kullan ve her id için tek karar üret. Yalnızca geçerli JSON döndür, açıklama veya markdown ekleme: {\"decisions\":[{\"id\":1,\"score\":80,\"decision\":\"KEEP\",\"reason\":\"kısa gerekçe\"}]}",
    ].join("\n"),
    history: [],
    message: JSON.stringify(pending),
  });

  let report = result.content.trim();
  if (!report || report.length < 20) {
    return NextResponse.json({ ok: false, error: "Model kullanılabilir bir analiz raporu üretmedi; sonuç kaydedilmedi." }, { status: 502 });
  }

  let decisions: { id: number; score: number; decision: "KEEP" | "REJECT"; reason: string }[];
  try {
    const parsed = JSON.parse(report.replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "")) as { decisions?: unknown };
    if (!Array.isArray(parsed.decisions)) throw new Error("Karar listesi yok.");
    decisions = parsed.decisions.map((value) => {
      const item = value as Record<string, unknown>;
      const id = Number(item.id);
      const score = Number(item.score);
      if (!pending.some((draft) => draft.id === id) || !Number.isFinite(score) || typeof item.reason !== "string" || (item.decision !== "KEEP" && item.decision !== "REJECT")) throw new Error("Geçersiz karar.");
      return { id, score: Math.max(0, Math.min(100, score)), decision: item.decision as "KEEP" | "REJECT", reason: item.reason.slice(0, 500) };
    });
    if (new Set(decisions.map((item) => item.id)).size !== pending.length || decisions.length !== pending.length) throw new Error("Her taslak için bir karar gelmedi.");
  } catch {
    return NextResponse.json({ ok: false, error: "Mira'nın kararları geçerli JSON değil; güvenlik için hiçbir içerik silinmedi.", deleted: 0 }, { status: 502 });
  }

  const keep = decisions.filter((item) => item.decision === "KEEP" && item.score >= 60)
    .sort((a, b) => b.score - a.score).slice(0, 3);
  const keepIds = new Set(keep.map((item) => item.id));
  const rejected = pending.filter((item) => !keepIds.has(item.id));
  report = [
    "MİRA İÇERİK SEÇİMİ",
    "",
    "TASLAKLARDA KALANLAR:",
    ...(keep.length ? keep.map((item, i) => `${i + 1}. ${pending.find((draft) => draft.id === item.id)?.title} — ${item.score}/100 — ${item.reason}`) : ["60 puan ve üzeri içerik bulunamadı."]),
    "",
    "ARŞİVLENENLER (silinmez; panelde 'reddedildi' olarak görünür):",
    ...(rejected.length ? rejected.map((item) => `- ${item.title} — ${decisions.find((decision) => decision.id === item.id)?.reason ?? "Mira seçmedi"}`) : ["Yok"]),
  ].join("\n");

  const [saved] = await db.insert(operations).values({
    action: "content_draft_analysis",
    summary: `Mira biriken ${pending.length} içerik taslağını analiz etti.`,
    status: "success",
    platform: "youtube",
    metadata: {
      analyzedContentIds: pending.map((draft) => draft.id),
      decisions,
      keptContentIds: [...keepIds],
      archivedContentIds: rejected.map((draft) => draft.id),
      titles: pending.map((draft) => ({ id: draft.id, title: draft.title })),
      report,
      provider: result.provider,
      model: result.model,
      published: false,
      draftsChanged: true,
    },
  }).returning();

  let archivedCount = 0;
  for (const item of rejected) {
    await db.delete(contentAssets).where(eq(contentAssets.contentId, item.id));
    const archived = await db.update(contentItems)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(and(eq(contentItems.id, item.id), eq(contentItems.status, "draft")))
      .returning({ id: contentItems.id });
    if (archived.length) {
      archivedCount++;
      await db.insert(operations).values({
        action: "content_auto_archived",
        summary: `Mira beğenmediği içeriği arşive aldı (silinmedi, kurtarılabilir): ${item.title}`,
        status: "success",
        platform: drafts.find((draft) => draft.id === item.id)?.platform ?? "youtube",
        metadata: { contentId: item.id, reason: decisions.find((decision) => decision.id === item.id)?.reason ?? "Mira seçmedi", analysisOperationId: saved.id },
      });
    }
  }

  return NextResponse.json({
    ok: true,
    analyzed: true,
    count: pending.length,
    kept: keep.length,
    deleted: archivedCount,
    archived: archivedCount,
    keptTitles: keep.map((item) => pending.find((draft) => draft.id === item.id)?.title),
    deletedTitles: rejected.filter((item) => !keepIds.has(item.id)).map((item) => item.title),
    archivedTitles: rejected.filter((item) => !keepIds.has(item.id)).map((item) => item.title),
    contentIds: pending.map((draft) => draft.id),
    report,
    provider: result.provider,
    model: result.model,
    operationId: saved.id,
    published: false,
    draftsChanged: true,
  });
}
