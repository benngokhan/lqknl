import { db } from "@/db";
import { contentItems, operations } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return true;
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });
  const status = new URL(req.url).searchParams.get("status");
  const rows = await db.select().from(contentItems)
    .where(status ? eq(contentItems.status, status) : undefined)
    .orderBy(desc(contentItems.updatedAt))
    .limit(100);
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  if (typeof b.title !== "string" || typeof b.platform !== "string") {
    return NextResponse.json({ error: "title ve platform gerekli" }, { status: 400 });
  }
  const [row] = await db.insert(contentItems).values({
    title: b.title.slice(0, 300),
    platform: b.platform.slice(0, 40),
    status: typeof b.status === "string" ? b.status.slice(0, 40) : "draft",
    topic: typeof b.topic === "string" ? b.topic.slice(0, 300) : null,
    externalId: typeof b.externalId === "string" ? b.externalId : null,
    url: typeof b.url === "string" ? b.url : null,
    views: Number.isFinite(b.views) ? Math.max(0, Math.trunc(b.views)) : 0,
    likes: Number.isFinite(b.likes) ? Math.max(0, Math.trunc(b.likes)) : 0,
    comments: Number.isFinite(b.comments) ? Math.max(0, Math.trunc(b.comments)) : 0,
    publishedAt: b.publishedAt ? new Date(b.publishedAt) : null,
  }).returning();
  await db.insert(operations).values({
    action: "content_create",
    summary: `İçerik kaydı oluşturuldu: ${row.title}`,
    status: "success",
    platform: row.platform,
    externalId: row.externalId,
    metadata: { contentId: row.id, contentStatus: row.status },
  });
  return NextResponse.json(row, { status: 201 });
}
