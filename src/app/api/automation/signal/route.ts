import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { operations } from "@/db/schema";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  return expected ? req.headers.get("x-mira-key") === expected : process.env.NODE_ENV !== "production";
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const body = await req.json().catch(() => null) as { directive?: unknown; source?: unknown } | null;
  const directive = body?.directive;
  if (!directive || typeof directive !== "object" || Array.isArray(directive)) {
    return NextResponse.json({ error: "directive alanında JSON nesnesi gerekli." }, { status: 400 });
  }

  const value = directive as Record<string, unknown>;
  const strong = value.agirlik_artir;
  const weak = value.azalt_durdur;
  const clones = value.klonlanacak_videolar;
  if (!Array.isArray(strong) || !Array.isArray(weak) || !Array.isArray(clones)) {
    return NextResponse.json({
      error: "Direktif şeması geçersiz: agirlik_artir, azalt_durdur ve klonlanacak_videolar dizileri gerekli.",
    }, { status: 400 });
  }

  const [saved] = await db.insert(operations).values({
    action: "channel_signal_directive",
    summary: "Haftalık YouTube kanal sinyal direktifi kaydedildi",
    status: "success",
    metadata: {
      directive: value,
      source: typeof body?.source === "string" ? body.source.slice(0, 100) : "channel_pulse.py",
      receivedAt: new Date().toISOString(),
    },
  }).returning();

  return NextResponse.json({
    ok: true,
    saved: true,
    operationId: saved.id,
    period: typeof value.donem === "string" ? value.donem : null,
    strongClusters: strong.length,
    weakClusters: weak.length,
    cloneCandidates: clones.length,
  });
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  const [latest] = await db.select().from(operations)
    .where(and(eq(operations.action, "channel_signal_directive"), eq(operations.status, "success")))
    .orderBy(desc(operations.id))
    .limit(1);
  if (!latest) return NextResponse.json({ ok: true, available: false, directive: null });
  const meta = latest.metadata && typeof latest.metadata === "object"
    ? latest.metadata as Record<string, unknown> : {};
  return NextResponse.json({
    ok: true,
    available: true,
    operationId: latest.id,
    receivedAt: meta.receivedAt ?? null,
    directive: meta.directive ?? null,
  });
}
