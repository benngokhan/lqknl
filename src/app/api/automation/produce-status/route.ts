import { isMiraSessionCookie } from "@/lib/mira-auth";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { operations } from "@/db/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return true;
  return isMiraSessionCookie(req.headers.get("cookie"));
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  const url = new URL(req.url);
  const contentId = Number(url.searchParams.get("contentId"));
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return NextResponse.json({ error: "Geçerli contentId gerekli" }, { status: 400 });
  }

  const rows = await db.select().from(operations)
    .where(eq(operations.action, "content_produce_progress"))
    .orderBy(desc(operations.id))
    .limit(500);
  const row = rows.find((item) => {
    const metadata = item.metadata && typeof item.metadata === "object"
      ? item.metadata as Record<string, unknown>
      : {};
    return Number(metadata.contentId) === contentId;
  });

  if (!row) {
    return NextResponse.json({ contentId, percentage: 0, stage: "Üretim durumu bekleniyor", status: "waiting" });
  }

  const metadata = row.metadata && typeof row.metadata === "object"
    ? row.metadata as Record<string, unknown>
    : {};
  return NextResponse.json({
    contentId,
    percentage: typeof metadata.percentage === "number" ? metadata.percentage : 0,
    stage: typeof metadata.stage === "string" ? metadata.stage : row.summary,
    status: row.status,
    updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : row.createdAt.toISOString(),
  });
}
