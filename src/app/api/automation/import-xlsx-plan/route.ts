import { NextResponse } from "next/server";
import { selfOrigin } from "@/lib/self-url";
import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@/db";
import { operations } from "@/db/schema";
import { parsePlanXlsx } from "@/lib/content-plan";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const PLAN_FILE = "Bilgi_Dozu_20_Short_Icerikleri.xlsx";

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return true;
  const hasEntryCookie = req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
  if (hasEntryCookie) return true;
  return !expected && process.env.NODE_ENV !== "production";
}

/**
 * Repo kökündeki içerik planını (xlsx) okur ve her satırı mevcut queue hattına akıtır.
 * Kopya kontrolü + görev kaydı queue route'unun kendi sözleşmesi sayesinde tekrar yazılmaz.
 * POST {} | {max?: number, platform?: string}
 */
export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const max = Number(body.max) > 0 ? Math.min(50, Math.floor(Number(body.max))) : 50;
  const platform = typeof body.platform === "string" && body.platform.trim() ? body.platform.trim().slice(0, 40) : "youtube";

  let buf: Buffer;
  try {
    buf = await fs.readFile(path.join(process.cwd(), PLAN_FILE));
  } catch {
    return NextResponse.json({ error: `${PLAN_FILE} deposun kökünde bulunamadı.` }, { status: 404 });
  }

  const rows = parsePlanXlsx(buf).slice(0, max);
  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: "Plan dosyasında işlenebilir satır bulunamadı." }, { status: 400 });
  }

  const origin = selfOrigin();
  const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "";
  const results: { title: string; status: "queued" | "duplicate" | "error"; detail?: string }[] = [];
  for (const row of rows) {
    try {
      const res = await fetch(`${origin}/api/automation/queue`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mira-key": secret },
        body: JSON.stringify({ title: row.title, topic: row.topic, platform }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) results.push({ title: row.title, status: "queued" });
      else if (res.status === 409) results.push({ title: row.title, status: "duplicate", detail: data?.error });
      else results.push({ title: row.title, status: "error", detail: data?.error || `HTTP ${res.status}` });
    } catch (error) {
      results.push({ title: row.title, status: "error", detail: error instanceof Error ? error.message.slice(0, 120) : String(error) });
    }
  }

  const queued = results.filter((r) => r.status === "queued").length;
  const duplicates = results.filter((r) => r.status === "duplicate").length;
  const errors = results.filter((r) => r.status === "error").length;
  await db.insert(operations).values({
    action: "automation_xlsx_import",
    summary: `İçerik planı içe aktarıldı: ${queued} yeni, ${duplicates} kopya, ${errors} hata`,
    status: errors > 0 ? "partial" : "success",
    platform,
    metadata: { file: PLAN_FILE, queued, duplicates, errors, results },
  });

  return NextResponse.json({ ok: true, total: rows.length, queued, duplicates, errors, results });
}
