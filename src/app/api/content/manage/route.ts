import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contentItems, operations } from "@/db/schema";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return true;
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

function objectMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });

  const rows = await db.select().from(contentItems).orderBy(desc(contentItems.updatedAt)).limit(200);
  const draftOps = await db.select().from(operations)
    .where(eq(operations.action, "autonomous_content_draft"))
    .orderBy(desc(operations.id))
    .limit(1000);

  const latestById = new Map<number, { script: string | null; provider: unknown; model: unknown; operationId: number | null }>();
  for (const operation of draftOps) {
    const metadata = objectMetadata(operation.metadata);
    const contentId = Number(metadata.contentId);
    if (!Number.isInteger(contentId) || contentId <= 0 || latestById.has(contentId)) continue;
    latestById.set(contentId, {
      script: typeof metadata.script === "string" ? metadata.script : null,
      provider: metadata.provider ?? null,
      model: metadata.model ?? null,
      operationId: operation.id,
    });
  }

  return NextResponse.json(rows.map((row) => {
    const generation = latestById.get(row.id);
    return {
      ...row,
      generatedScript: generation?.script ?? null,
      generation: generation ? { provider: generation.provider, model: generation.model } : null,
    };
  }));
}

export async function PATCH(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Geçersiz taslak numarası." }, { status: 400 });

  const [existing] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
  if (!existing) return NextResponse.json({ error: "Taslak bulunamadı." }, { status: 404 });

  const action = typeof body.action === "string" ? body.action : "";
  const patch: Partial<typeof contentItems.$inferInsert> = { updatedAt: new Date() };

  if (action === "archive") patch.status = "archived";
  else if (action === "restore") patch.status = "draft";
  else if (action === "delete") patch.status = "deleted";
  else {
    if (typeof body.title === "string") {
      const title = body.title.trim();
      if (!title) return NextResponse.json({ error: "Başlık boş bırakılamaz." }, { status: 400 });
      patch.title = title.slice(0, 300);
    }
    if (typeof body.topic === "string") patch.topic = body.topic.trim().slice(0, 500);
    if (typeof body.platform === "string" && body.platform.trim()) patch.platform = body.platform.trim().slice(0, 40);
    const allowedStatuses = ["draft", "queued", "processing", "failed", "ready", "approved", "rejected", "archived", "deleted"];
    if (typeof body.status === "string" && allowedStatuses.includes(body.status)) patch.status = body.status;
  }

  const [row] = await db.update(contentItems).set(patch).where(eq(contentItems.id, id)).returning();
  if (!row) return NextResponse.json({ error: "Taslak güncellenemedi." }, { status: 409 });

  if (typeof body.generatedScript === "string") {
    const draftOps = await db.select().from(operations)
      .where(eq(operations.action, "autonomous_content_draft"))
      .orderBy(desc(operations.id))
      .limit(1000);
    const matching = draftOps.find((operation) => Number(objectMetadata(operation.metadata).contentId) === id);
    if (matching) {
      const metadata = objectMetadata(matching.metadata);
      await db.update(operations).set({
        metadata: { ...metadata, script: body.generatedScript.slice(0, 50000), editedInTaskCenter: true },
        summary: `Görev Merkezi'nde düzenlenen senaryo: ${row.title}`.slice(0, 1000),
      }).where(eq(operations.id, matching.id));
    } else {
      await db.insert(operations).values({
        action: "autonomous_content_draft",
        summary: `Görev Merkezi'nde senaryo kaydedildi: ${row.title}`,
        status: "success",
        platform: row.platform,
        metadata: { contentId: id, script: body.generatedScript.slice(0, 50000), editedInTaskCenter: true },
      });
    }
  }

  await db.insert(operations).values({
    action: "task_center_content_update",
    summary: `Görev Merkezi işlemi: #${id} · ${row.title}`.slice(0, 1000),
    status: "success",
    platform: row.platform,
    metadata: { contentId: id, requestedAction: action || "edit", status: row.status },
  });

  return NextResponse.json({ ok: true, content: row, message: action === "delete" ? "Taslak silinenlere taşındı; kayıt geri alınabilir." : action === "archive" ? "Taslak arşivlendi." : action === "restore" ? "Taslak geri yüklendi." : "Taslak kaydedildi." });
}

export async function DELETE(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Geçersiz taslak numarası." }, { status: 400 });
  const [row] = await db.update(contentItems)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(eq(contentItems.id, id))
    .returning();
  if (!row) return NextResponse.json({ error: "Taslak bulunamadı." }, { status: 404 });
  await db.insert(operations).values({
    action: "task_center_content_delete",
    summary: `Taslak silinenlere taşındı: #${id} · ${row.title}`.slice(0, 1000),
    status: "success",
    platform: row.platform,
    metadata: { contentId: id, softDelete: true },
  });
  return NextResponse.json({ ok: true, message: "Taslak silinenlere taşındı; kayıt geri alınabilir." });
}
