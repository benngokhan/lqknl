import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { contentItems, operations, tasks } from "@/db/schema";
import { normalizeTitleKey } from "@/lib/dedupe-content";

export const dynamic = "force-dynamic";

function authMode(req: Request): "key" | "panel" | null {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return "key";
  const hasEntryCookie = req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
  if (hasEntryCookie) return "panel";
  if (!expected && process.env.NODE_ENV !== "production") return "key";
  return null;
}

export async function GET(req: Request) {
  const mode = authMode(req);
  if (!mode) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  const rows = await db.select().from(contentItems)
    .where(inArray(contentItems.status, ["queued", "processing", "failed"]))
    .orderBy(desc(contentItems.createdAt)).limit(40);
  return NextResponse.json(rows.map((row) => ({ id: row.id, title: row.title, topic: row.topic, platform: row.platform, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt })));
}

export async function POST(req: Request) {
  const mode = authMode(req);
  if (!mode) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const b = await req.json().catch(() => ({}));

  // Retry the existing failed item in place; never create a duplicate topic.
  const retryContentId = Number(b.retryContentId);
  if (Number.isInteger(retryContentId) && retryContentId > 0) {
    const [retried] = await db.update(contentItems)
      .set({ status: "queued", updatedAt: new Date() })
      .where(and(eq(contentItems.id, retryContentId), eq(contentItems.status, "failed")))
      .returning({ id: contentItems.id, title: contentItems.title, status: contentItems.status });
    if (!retried) return NextResponse.json({ error: "İçerik bulunamadı veya yeniden denemeye uygun değil." }, { status: 409 });
    await db.insert(operations).values({
      action: "content_pipeline_retry",
      summary: `Mevcut içerik yeniden kuyruğa alındı: ${retried.title}`,
      status: "queued",
      platform: "youtube",
      metadata: { contentId: retryContentId, retryable: true, duplicateCreated: false },
    });
    return NextResponse.json({ ok: true, content: retried, duplicateCreated: false }, { status: 200 });
  }

  const topic = typeof b.topic === "string" ? b.topic.trim().slice(0, 500) : "";
  const platform = typeof b.platform === "string" ? b.platform.trim().slice(0, 40) : "youtube";
  const title = typeof b.title === "string" && b.title.trim()
    ? b.title.trim().slice(0, 300)
    : topic.slice(0, 300) || "Yeni içerik";

  if (!topic) {
    return NextResponse.json({ error: "topic gerekli" }, { status: 400 });
  }

  // Kopya koruması: son 30 günde aynı normalize başlık/konu varsa yeni kayıt açma.
  const dupWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recent = await db.select({ id: contentItems.id, title: contentItems.title, topic: contentItems.topic, status: contentItems.status })
    .from(contentItems)
    .where(gte(contentItems.createdAt, dupWindow))
    .limit(400);
  const newKey = normalizeTitleKey(title);
  const topicKey = normalizeTitleKey(topic);
  const duplicate = recent.find((row) =>
    (newKey && normalizeTitleKey(row.title) === newKey) ||
    (topicKey && normalizeTitleKey(row.topic) === topicKey) ||
    (topicKey && normalizeTitleKey(row.title) === topicKey));
  if (duplicate) {
    return NextResponse.json({
      ok: false,
      error: `Aynı başlık/konu zaten kayıtlı (#${duplicate.id}, durum: ${duplicate.status}); yeni kopya açılmadı.`,
      existingId: duplicate.id,
      existingStatus: duplicate.status,
    }, { status: 409 });
  }

  const [content] = await db.insert(contentItems).values({
    title,
    platform,
    status: "queued",
    topic,
  }).returning();

  const [task] = await db.insert(tasks).values({
    title: `İçerik üretim hattını çalıştır: ${title}`,
    status: "pending",
    source: "mira",
    notes: JSON.stringify({
      type: "content_pipeline",
      contentId: content.id,
      platform,
      stages: ["research", "script", "voice", "video", "publish", "report"],
    }),
  }).returning();

  const [operation] = await db.insert(operations).values({
    action: "content_pipeline_queue",
    summary: `İçerik üretim hattına alındı: ${title}`,
    status: "queued",
    platform,
    metadata: {
      contentId: content.id,
      taskId: task.id,
      topic,
      stages: ["research", "script", "voice", "video", "publish", "report"],
    },
  }).returning();

  const manualKick = false; // Kuyruğa eklemek üretimi başlatmaz; zamanlama veya kullanıcı butonu başlatır.

  return NextResponse.json({
    ok: true,
    content,
    task,
    operation,
    manualKick,
    pipeline: {
      status: "queued",
      stages: ["research", "script", "voice", "video", "publish", "report"],
      next: "research",
    },
  }, { status: 201 });
}
