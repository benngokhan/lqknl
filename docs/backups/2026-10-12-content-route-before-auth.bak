import { db } from "@/db";
import { contentItems, operations } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET(req: Request) { const status = new URL(req.url).searchParams.get("status"); const rows = await db.select().from(contentItems).where(status ? eq(contentItems.status, status) : undefined).orderBy(desc(contentItems.updatedAt)).limit(100); return NextResponse.json(rows); }
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  if (typeof b.title !== "string" || typeof b.platform !== "string") return NextResponse.json({ error: "title ve platform gerekli" }, { status: 400 });
  const [row] = await db.insert(contentItems).values({ title: b.title.slice(0,300), platform: b.platform.slice(0,40), status: typeof b.status === "string" ? b.status.slice(0,40) : "draft", topic: typeof b.topic === "string" ? b.topic.slice(0,300) : null, externalId: typeof b.externalId === "string" ? b.externalId : null, url: typeof b.url === "string" ? b.url : null, views: Number.isFinite(b.views) ? Math.max(0, Math.trunc(b.views)) : 0, likes: Number.isFinite(b.likes) ? Math.max(0, Math.trunc(b.likes)) : 0, comments: Number.isFinite(b.comments) ? Math.max(0, Math.trunc(b.comments)) : 0, publishedAt: b.publishedAt ? new Date(b.publishedAt) : null }).returning();
  await db.insert(operations).values({ action: "content_create", summary: `İçerik kaydı oluşturuldu: ${row.title}`, status: "success", platform: row.platform, externalId: row.externalId, metadata: { contentId: row.id, contentStatus: row.status } });
  return NextResponse.json(row, { status: 201 });
}
