import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { operations } from "@/db/schema";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
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

  return NextResponse.json({
    report: typeof meta.report === "string" ? meta.report : null,
    createdAt: latest.createdAt,
    titles: Array.isArray(meta.titles) ? meta.titles : [],
    provider: typeof meta.provider === "string" ? meta.provider : null,
    model: typeof meta.model === "string" ? meta.model : null,
    published: false,
    draftsChanged: false,
  });
}
