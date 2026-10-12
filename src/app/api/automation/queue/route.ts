import { NextResponse } from "next/server";
import { gte } from "drizzle-orm";
import { db } from "@/db";
import { contentItems, operations, tasks } from "@/db/schema";
import { normalizeTitleKey } from "@/lib/dedupe-content";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  return req.headers.get("x-mira-key") === expected;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
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

  return NextResponse.json({
    ok: true,
    content,
    task,
    operation,
    pipeline: {
      status: "queued",
      stages: ["research", "script", "voice", "video", "publish", "report"],
      next: "research",
    },
  }, { status: 201 });
}
