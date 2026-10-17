import { isMiraSessionCookie } from "@/lib/mira-auth";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { contentItems, operations } from "@/db/schema";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  return isMiraSessionCookie(req.headers.get("cookie"));
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });

  const [latest] = await db.select().from(operations)
    .where(eq(operations.action, "content_draft_analysis"))
    .orderBy(desc(operations.id))
    .limit(1);

  if (!latest) return NextResponse.json({ report: null, createdAt: null, titles: [], provider: null, model: null });

  const meta = latest.metadata && typeof latest.metadata === "object"
    ? latest.metadata as Record<string, unknown>
    : {};

  // Only show items explicitly kept by analysis and still awaiting user review.
  // Rejected/approved/deleted items must not reappear from this historical report.
  const keptIds = new Set(
    Array.isArray(meta.keptContentIds)
      ? meta.keptContentIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [],
  );
  const liveDrafts = await db.select({ id: contentItems.id }).from(contentItems)
    .where(eq(contentItems.status, "draft"));
  const liveDraftIds = new Set(liveDrafts.map((item) => item.id));
  const titles = Array.isArray(meta.titles)
    ? (meta.titles as Array<{ id?: unknown; title?: unknown }>).filter((item) => {
        const id = Number(item?.id);
        return Number.isInteger(id) && keptIds.has(id) && liveDraftIds.has(id);
      })
    : [];

  return NextResponse.json({
    report: typeof meta.report === "string" ? meta.report : null,
    createdAt: latest.createdAt,
    titles,
    provider: typeof meta.provider === "string" ? meta.provider : null,
    model: typeof meta.model === "string" ? meta.model : null,
    published: false,
    draftsChanged: false,
  });
}
