import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { operations } from "@/db/schema";
import { LOG_ACTION } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return true;
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

type LogRow = {
  id: number;
  at: string;
  level: string;
  source: string;
  message: string;
  meta: Record<string, unknown>;
};

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const url = new URL(req.url);
  const level = (url.searchParams.get("level") || "").trim().toLowerCase();
  const source = (url.searchParams.get("source") || "").trim().toLowerCase();
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const contentIdParam = url.searchParams.get("contentId");
  const contentId = contentIdParam ? Number(contentIdParam) : null;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 80));

  // Son 900 operasyon satırı içinden log kayıtlarını ayıkla (yerel filtre)
  const rows = await db.select().from(operations).orderBy(desc(operations.id)).limit(900);

  const logs: LogRow[] = [];
  for (const row of rows) {
    if (row.action !== LOG_ACTION) continue;
    const meta = row.metadata && typeof row.metadata === "object"
      ? row.metadata as Record<string, unknown>
      : {};
    const rowLevel = String(meta.level ?? (row.status === "failed" ? "error" : row.status === "warn" ? "warn" : "info"));
    const rowSource = String(row.platform ?? meta.source ?? "");
    if (level && rowLevel !== level) continue;
    if (source && !rowSource.toLowerCase().includes(source)) continue;
    if (contentId !== null && Number(meta.contentId) !== contentId) continue;
    if (q) {
      const haystack = `${row.summary ?? ""} ${JSON.stringify(meta)}`.toLowerCase();
      if (!haystack.includes(q)) continue;
    }
    logs.push({
      id: row.id,
      at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      level: rowLevel,
      source: rowSource,
      message: row.summary ?? "",
      meta,
    });
    if (logs.length >= limit) break;
  }

  return NextResponse.json({ ok: true, count: logs.length, logs });
}
