import { NextResponse } from "next/server";
import { db } from "@/db";
import { contentItems, operations, tasks, trends } from "@/db/schema";
import { isPermanentlyDeletedTopic } from "@/lib/deleted-topics";

function authorized(req: Request) {
  const expected = process.env.MIRA_N8N_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  return req.headers.get("x-mira-key") === expected;
}
export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const type = String(b.type ?? "operation");
  if (type === "task") {
    const [row] = await db.insert(tasks).values({ title: String(b.title ?? "Yeni görev").slice(0,300), dueAt: b.dueAt ? new Date(b.dueAt) : null, recurrence: b.recurrence ? String(b.recurrence).slice(0,100) : null, source: "n8n", notes: b.notes ? String(b.notes).slice(0,2000) : null }).returning();
    return NextResponse.json({ ok: true, type, row });
  }
  if (type === "content") {
    const title = String(b.title ?? "İçerik").slice(0, 300);
    const topic = b.topic ? String(b.topic).slice(0, 300) : "";
    if (await isPermanentlyDeletedTopic(db, [title, topic])) return NextResponse.json({ error: "Bu başlık/konu kalıcı olarak silindi; tekrar kaydedilemez." }, { status: 410 });
    const [row] = await db.insert(contentItems).values({ title, platform: String(b.platform ?? "unknown").slice(0,40), status: String(b.status ?? "draft").slice(0,40), topic: topic || null, externalId: b.externalId ? String(b.externalId) : null, url: b.url ? String(b.url) : null, views: Number(b.views) || 0, likes: Number(b.likes) || 0, comments: Number(b.comments) || 0, publishedAt: b.publishedAt ? new Date(b.publishedAt) : null }).returning();
    return NextResponse.json({ ok: true, type, row });
  }
  if (type === "trend") {
    const topic = String(b.topic ?? "Trend").slice(0, 300);
    if (await isPermanentlyDeletedTopic(db, [topic])) return NextResponse.json({ error: "Bu konu kalıcı olarak silindi; tekrar kaydedilemez." }, { status: 410 });
    const [row] = await db.insert(trends).values({ topic, platform: b.platform ? String(b.platform).slice(0,40) : null, sourceUrl: b.sourceUrl ? String(b.sourceUrl).slice(0,1000) : null, score: Number.isFinite(Number(b.score)) ? Number(b.score) : null, notes: b.notes ? String(b.notes).slice(0,2000) : null }).returning();
    return NextResponse.json({ ok: true, type, row });
  }
  const [row] = await db.insert(operations).values({ action: String(b.action ?? "n8n_operation").slice(0,100), summary: String(b.summary ?? "n8n işlemi").slice(0,1000), status: String(b.status ?? "success").slice(0,40), platform: b.platform ? String(b.platform).slice(0,40) : null, externalId: b.externalId ? String(b.externalId) : null, metadata: b.metadata ?? null }).returning();
  return NextResponse.json({ ok: true, type: "operation", row });
}
