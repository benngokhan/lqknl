import { db } from "@/db";
import { contentItems, operations } from "@/db/schema";
import { isPermanentlyDeletedTopic } from "@/lib/deleted-topics";
import { desc, eq, ne } from "drizzle-orm";
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
  if (status === "deleted") return NextResponse.json([]);
  const rows = await db.select().from(contentItems)
    .where(status ? eq(contentItems.status, status) : ne(contentItems.status, "deleted"))
    .orderBy(desc(contentItems.updatedAt))
    .limit(100);
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });
  return NextResponse.json({
    error: "Elle içerik kaydetme kapatıldı. Yeni içerik kaynağı Google Drive'dır.",
    source: "google_drive",
  }, { status: 410 });
}
