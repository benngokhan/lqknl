import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { contentItems, operations } from "@/db/schema";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });

  const status = new URL(req.url).searchParams.get("status");
  const rows = await db.select().from(contentItems)
    .where(status === "approved" || status === "rejected"
      ? eq(contentItems.status, status)
      : inArray(contentItems.status, ["queued", "processing", "draft"]))
    .orderBy(desc(contentItems.updatedAt))
    .limit(50);

  if (!rows.length) return NextResponse.json([]);
  const ids = rows.map((row) => row.id);
  const draftOps = await db.select().from(operations)
    .where(and(eq(operations.action, "autonomous_content_draft"), inArray(operations.status, ["success", "failed"])))
    .orderBy(desc(operations.id))
    .limit(500);

  const latestById = new Map<number, (typeof draftOps)[number]>();
  for (const op of draftOps) {
    const metadata = op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {};
    const id = Number(metadata.contentId);
    if (ids.includes(id) && !latestById.has(id) && typeof metadata.script === "string") latestById.set(id, op);
  }

  return NextResponse.json(rows.map((row) => {
    const op = latestById.get(row.id);
    const metadata = op?.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {};
    return {
      ...row,
      generatedScript: typeof metadata.script === "string" ? metadata.script : null,
      generation: op ? { provider: metadata.provider ?? null, model: metadata.model ?? null } : null,
    };
  }));
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const action = body.action;
  if (!Number.isInteger(id) || id <= 0 || !["approve_video", "approve_text", "reject"].includes(action)) {
    return NextResponse.json({ error: "Geçersiz istek." }, { status: 400 });
  }

  const [draft] = await db.select().from(contentItems)
    .where(and(eq(contentItems.id, id), eq(contentItems.status, "draft")))
    .limit(1);

  if (!draft) return NextResponse.json({ error: "Taslak bulunamadı veya daha önce değerlendirilmiş." }, { status: 409 });

  const nextStatus = action === "reject" ? "rejected" : "approved";
  const videoRequested = action === "approve_video";
  const [row] = await db.update(contentItems)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(and(eq(contentItems.id, id), eq(contentItems.status, "draft")))
    .returning();

  if (!row) {
    return NextResponse.json({
      error: action === "approve"
        ? "n8n isteği kabul etti ancak taslak durumu değiştirilemedi. n8n çalışmasını kontrol et."
        : "Taslak başka bir işlem tarafından değerlendirilmiş.",
    }, { status: 409 });
  }

  await db.insert(operations).values({
    action: action === "reject" ? "content_rejected" : "content_approved",
    summary: action === "reject"
      ? `İçerik taslağı kullanıcı tarafından reddedildi: ${row.title}`
      : videoRequested
        ? `İçerik onaylandı; video üretimi istendi: ${row.title}`
        : `İçerik onaylandı; video üretimi istenmedi: ${row.title}`,
    status: "success",
    platform: row.platform,
    externalId: row.externalId,
    metadata: {
      contentId: row.id,
      contentStatus: nextStatus,
      approvedByUser: action !== "reject",
      videoRequested,
      n8nTriggered: false,
      published: false,
    },
  });

  return NextResponse.json({
    ok: true,
    status: nextStatus,
    n8nTriggered: false,
    published: false,
    message: action === "reject"
      ? "Taslak reddedildi."
      : videoRequested
        ? "Taslak onaylandı; video üretim kuyruğuna alındı. Sonuç Telegram'a bildirilecekse Telegram bağlantısı yapılandırılmış olmalı."
        : "Taslak onaylandı; video üretilmeyecek.",
    content: row,
  });
}
