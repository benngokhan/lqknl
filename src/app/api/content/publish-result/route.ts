import { db } from "@/db";
import { contentItems, operations } from "@/db/schema";
import { normalizePlatform } from "@/lib/platforms";
import { isPermanentlyDeletedTopic } from "@/lib/deleted-topics";
import { NextResponse } from "next/server";

function authorized(req: Request) {
  const expected = process.env.MIRA_N8N_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  return req.headers.get("x-mira-key") === expected;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const platform = normalizePlatform(b.platform);
  if (!platform || typeof b.title !== "string" || !b.title.trim()) {
    return NextResponse.json({ error: "platform ve title gerekli (youtube veya tiktok)" }, { status: 400 });
  }
  const views = Number.isFinite(b.views) ? Math.max(0, Math.trunc(Number(b.views))) : 0;
  const likes = Number.isFinite(b.likes) ? Math.max(0, Math.trunc(Number(b.likes))) : 0;
  const comments = Number.isFinite(b.comments) ? Math.max(0, Math.trunc(Number(b.comments))) : 0;
  const publishedAt = b.publishedAt ? new Date(b.publishedAt) : null;
  if (publishedAt && Number.isNaN(publishedAt.getTime())) return NextResponse.json({ error: "Geçersiz publishedAt" }, { status: 400 });
  if (await isPermanentlyDeletedTopic(db, [b.title, typeof b.topic === "string" ? b.topic : ""])) {
    return NextResponse.json({ error: "Bu başlık/konu kalıcı olarak silindi; yayın sonucu kaydedilemez." }, { status: 410 });
  }

  const [row] = await db.insert(contentItems).values({
    title: b.title.trim().slice(0, 300),
    platform,
    status: b.status === "failed" ? "failed" : b.status === "draft" ? "draft" : "published",
    topic: typeof b.topic === "string" ? b.topic.slice(0, 300) : null,
    externalId: typeof b.externalId === "string" ? b.externalId.slice(0, 500) : null,
    url: typeof b.url === "string" ? b.url.slice(0, 2000) : null,
    views, likes, comments, publishedAt,
  }).returning();

  await db.insert(operations).values({
    action: row.status === "published" ? "publish" : "publish_result",
    summary: row.status === "published" ? `${platform} yayınlandı: ${row.title}` : `${platform} yayın sonucu kaydedildi: ${row.title}`,
    status: row.status === "failed" ? "failed" : "success",
    platform,
    externalId: row.externalId,
    metadata: { contentId: row.id, url: row.url, views, likes, comments, error: b.error ?? null },
  });
  return NextResponse.json(row, { status: 201 });
}
