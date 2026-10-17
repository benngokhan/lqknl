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
  const contentId = Number(new URL(req.url).searchParams.get("contentId"));
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return NextResponse.json({ error: "Geçerli contentId gerekli" }, { status: 400 });
  }

  const rows = await db.select().from(operations)
    .where(eq(operations.action, "content_produce_progress"))
    .orderBy(desc(operations.id))
    .limit(500);

  const events = rows
    .filter((row) => {
      const meta = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
      return Number(meta.contentId) === contentId;
    })
    .reverse()
    .map((row) => {
      const meta = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
      return {
        id: row.id,
        stage: typeof meta.stage === "string" ? meta.stage : row.summary,
        status: row.status,
        percentage: typeof meta.percentage === "number" ? meta.percentage : 0,
        detail: typeof meta.detail === "string" ? meta.detail : "",
        nextAction: typeof meta.nextAction === "string" ? meta.nextAction : "",
        createdAt: typeof meta.updatedAt === "string" ? meta.updatedAt : row.createdAt.toISOString(),
      };
    });

  return NextResponse.json({ contentId, events });
}
