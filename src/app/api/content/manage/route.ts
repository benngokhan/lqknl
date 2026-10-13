import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { contentAssets, contentItems, learningProgress, memories, operations, tasks, trends } from "@/db/schema";
import { deletedTopicHash, isPermanentlyDeletedTopic } from "@/lib/deleted-topics";
import { normalizeTitleKey } from "@/lib/dedupe-content";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return true;
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

function objectMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function scrubText(value: string, terms: string[]): string {
  let result = value;
  for (const term of [...terms].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), "[kalıcı olarak silindi]");
  }
  return result;
}

function scrubValue(value: unknown, terms: string[], deletedIds: Set<number>): unknown {
  if (typeof value === "string") return scrubText(value, terms);
  if (Array.isArray(value)) return value
    .filter((item) => !(typeof item === "number" && deletedIds.has(item)))
    .map((item) => scrubValue(item, terms, deletedIds));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "contentId" || key === "taskId") && typeof item === "number" && deletedIds.has(item)) continue;
      if ((key === "keptContentIds" || key === "deletedContentIds") && Array.isArray(item)) {
        result[key] = item.filter((entry) => !(typeof entry === "number" && deletedIds.has(entry)));
      } else {
        result[key] = scrubValue(item, terms, deletedIds);
      }
    }
    return result;
  }
  return value;
}

async function permanentlyDeleteContent(id: number) {
  const [selected] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
  if (!selected) return { ok: false as const, error: "Taslak bulunamadı." };

  const seedTerms = [selected.title, selected.topic || ""].filter((value) => value.trim().length > 0);
  const seedKeys = new Set(seedTerms.map(normalizeTitleKey).filter(Boolean));
  const allContent = await db.select().from(contentItems);
  const matched = allContent.filter((row) =>
    row.id === id ||
    seedKeys.has(normalizeTitleKey(row.title)) ||
    (row.topic ? seedKeys.has(normalizeTitleKey(row.topic)) : false)
  );
  const ids = [...new Set(matched.map((row) => row.id))];
  const idSet = new Set(ids);
  const terms = [...new Set([...seedTerms, ...matched.flatMap((row) => [row.title, row.topic || ""])])];
  const hashes = [...new Set(terms.map(deletedTopicHash).filter((value): value is string => Boolean(value)))];

  // Keep only one-way hashes as a tombstone: the deleted title/topic itself is not retained.
  if (ids.length) {
    const assets = await db.select({ id: contentAssets.id }).from(contentAssets).where(inArray(contentAssets.contentId, ids));
    const assetIds = assets.map((asset) => asset.id);
    if (assetIds.length) await db.delete(contentAssets).where(inArray(contentAssets.id, assetIds));
    await db.delete(contentItems).where(inArray(contentItems.id, ids));
  }

  const allTasks = await db.select().from(tasks);
  const taskIds = allTasks.filter((task) => {
    const notes = task.notes || "";
    return ids.some((contentId) => notes.includes(`"contentId":${contentId}`)) ||
      terms.some((term) => term && (task.title.toLocaleLowerCase("tr-TR").includes(term.toLocaleLowerCase("tr-TR")) || notes.toLocaleLowerCase("tr-TR").includes(term.toLocaleLowerCase("tr-TR"))));
  }).map((task) => task.id);
  if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));

  const allOperations = await db.select().from(operations);
  for (const operation of allOperations) {
    const metadata = objectMetadata(operation.metadata);
    const relatedId = Number(metadata.contentId);
    if (Number.isInteger(relatedId) && idSet.has(relatedId)) {
      await db.delete(operations).where(eq(operations.id, operation.id));
      continue;
    }
    const nextSummary = scrubText(operation.summary, terms);
    const nextMetadata = scrubValue(metadata, terms, idSet) as Record<string, unknown>;
    const changed = nextSummary !== operation.summary || JSON.stringify(nextMetadata) !== JSON.stringify(metadata);
    if (changed) {
      await db.update(operations).set({ summary: nextSummary, metadata: nextMetadata }).where(eq(operations.id, operation.id));
    }
  }

  const allTrends = await db.select().from(trends);
  const trendIds = allTrends.filter((row) => seedKeys.has(normalizeTitleKey(row.topic))).map((row) => row.id);
  if (trendIds.length) await db.delete(trends).where(inArray(trends.id, trendIds));

  const allMemories = await db.select().from(memories);
  const memoryIds = allMemories.filter((row) =>
    seedKeys.has(normalizeTitleKey(row.key)) ||
    seedKeys.has(normalizeTitleKey(row.value)) ||
    terms.some((term) => term && (row.key.toLocaleLowerCase("tr-TR").includes(term.toLocaleLowerCase("tr-TR")) || row.value.toLocaleLowerCase("tr-TR").includes(term.toLocaleLowerCase("tr-TR"))))
  ).map((row) => row.id);
  if (memoryIds.length) await db.delete(memories).where(inArray(memories.id, memoryIds));

  const allLearning = await db.select().from(learningProgress);
  const learningIds = allLearning.filter((row) => seedKeys.has(normalizeTitleKey(row.topic))).map((row) => row.id);
  if (learningIds.length) await db.delete(learningProgress).where(inArray(learningProgress.id, learningIds));

  await db.insert(operations).values({
    action: "content_permanently_deleted",
    summary: "İçerik kalıcı olarak silindi; yalnızca geri üretimi engelleyen gizli eşleşme özeti tutuluyor.",
    status: "success",
    metadata: { deletedTopicHashes: hashes, deletedAt: new Date().toISOString(), permanentlyDeleted: true },
  });

  return { ok: true as const, deletedCount: ids.length, message: "Taslak, senaryo, ilişkili medya ve konu kayıtları kalıcı olarak silindi. Başlık/konu metni saklanmadı; gizli hash engeli aynı başlığın yeniden kuyruğa alınmasını önleyecek." };
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });
  // Eski sürümün geri alınabilir silme kayıtlarını bir defaya mahsus kalıcı olarak temizle.
  const legacyDeleted = await db.select({ id: contentItems.id }).from(contentItems)
    .where(eq(contentItems.status, "deleted")).limit(500);
  for (const oldRow of legacyDeleted) await permanentlyDeleteContent(oldRow.id);
  const rows = await db.select().from(contentItems)
    .orderBy(desc(contentItems.updatedAt))
    .limit(500);
  const visibleRows = rows.filter((row) => row.status !== "deleted");
  const draftOps = await db.select().from(operations)
    .where(eq(operations.action, "autonomous_content_draft"))
    .orderBy(desc(operations.id))
    .limit(2000);

  const latestById = new Map<number, { script: string | null; provider: unknown; model: unknown }>();
  for (const operation of draftOps) {
    const metadata = objectMetadata(operation.metadata);
    const contentId = Number(metadata.contentId);
    if (!Number.isInteger(contentId) || contentId <= 0 || latestById.has(contentId)) continue;
    latestById.set(contentId, {
      script: typeof metadata.script === "string" ? metadata.script : null,
      provider: metadata.provider ?? null,
      model: metadata.model ?? null,
    });
  }
  const tombstones = await db.select({ metadata: operations.metadata }).from(operations)
    .where(eq(operations.action, "content_permanently_deleted")).limit(5000);
  const blockedHashes = new Set<string>();
  for (const row of tombstones) {
    const hashes = objectMetadata(row.metadata).deletedTopicHashes;
    if (Array.isArray(hashes)) hashes.forEach((hash) => { if (typeof hash === "string") blockedHashes.add(hash); });
  }

  return NextResponse.json(visibleRows.filter((row) =>
    ![row.title, row.topic || ""].some((value) => {
      const hash = deletedTopicHash(value);
      return Boolean(hash && blockedHashes.has(hash));
    })
  ).map((row) => {
    const generation = latestById.get(row.id);
    return {
      ...row,
      generatedScript: generation?.script ?? null,
      generation: generation ? { provider: generation.provider, model: generation.model } : null,
    };
  }));
}

export async function PATCH(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Geçersiz taslak numarası." }, { status: 400 });

  if (body.action === "permanent_delete") {
    const result = await permanentlyDeleteContent(id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
    return NextResponse.json(result);
  }

  const [existing] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
  if (!existing || existing.status === "deleted") return NextResponse.json({ error: "Taslak bulunamadı." }, { status: 404 });

  const action = typeof body.action === "string" ? body.action : "";
  const patch: Partial<typeof contentItems.$inferInsert> = { updatedAt: new Date() };
  if (action === "archive") patch.status = "archived";
  else if (action === "restore") patch.status = "draft";
  else {
    if (typeof body.title === "string") {
      const title = body.title.trim();
      if (!title) return NextResponse.json({ error: "Başlık boş bırakılamaz." }, { status: 400 });
      patch.title = title.slice(0, 300);
    }
    if (typeof body.topic === "string") patch.topic = body.topic.trim().slice(0, 500);
    if (typeof body.platform === "string" && body.platform.trim()) patch.platform = body.platform.trim().slice(0, 40);
    const allowedStatuses = ["draft", "queued", "processing", "failed", "ready", "approved", "rejected", "archived"];
    if (typeof body.status === "string" && allowedStatuses.includes(body.status)) patch.status = body.status;
  }

  const [row] = await db.update(contentItems).set(patch).where(eq(contentItems.id, id)).returning();
  if (!row) return NextResponse.json({ error: "Taslak güncellenemedi." }, { status: 409 });

  if (typeof body.generatedScript === "string") {
    const draftOps = await db.select().from(operations)
      .where(eq(operations.action, "autonomous_content_draft"))
      .orderBy(desc(operations.id)).limit(2000);
    const matching = draftOps.find((operation) => Number(objectMetadata(operation.metadata).contentId) === id);
    if (matching) {
      const metadata = objectMetadata(matching.metadata);
      await db.update(operations).set({
        metadata: { ...metadata, script: body.generatedScript.slice(0, 50000), editedInTaskCenter: true },
        summary: `Görev Merkezi'nde düzenlenen senaryo: ${row.title}`.slice(0, 1000),
      }).where(eq(operations.id, matching.id));
    } else {
      await db.insert(operations).values({
        action: "autonomous_content_draft",
        summary: `Görev Merkezi'nde senaryo kaydedildi: ${row.title}`,
        status: "success",
        platform: row.platform,
        metadata: { contentId: id, script: body.generatedScript.slice(0, 50000), editedInTaskCenter: true },
      });
    }
  }

  await db.insert(operations).values({
    action: "task_center_content_update",
    summary: `Görev Merkezi işlemi: #${id} · ${row.title}`.slice(0, 1000),
    status: "success",
    platform: row.platform,
    metadata: { contentId: id, requestedAction: action || "edit", status: row.status },
  });

  return NextResponse.json({ ok: true, content: row, message: action === "archive" ? "Taslak arşivlendi." : action === "restore" ? "Taslak geri yüklendi." : "Taslak kaydedildi." });
}

export async function DELETE(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Geçersiz taslak numarası." }, { status: 400 });
  const result = await permanentlyDeleteContent(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json(result);
}
