import { and, desc, eq, inArray } from "drizzle-orm";
import { selfOrigin } from "@/lib/self-url";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { contentAssets, contentItems, operations } from "@/db/schema";
import { splitDuplicateRows } from "@/lib/dedupe-content";

export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (expected && req.headers.get("x-mira-key") === expected) return true;
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });

  const status = new URL(req.url).searchParams.get("status");
  const isReady = status === "ready";
  const isDefaultView = !isReady && status !== "approved" && status !== "rejected";
  let rows = await db.select().from(contentItems)
    .where(isReady
      ? eq(contentItems.status, "ready")
      : status === "approved" || status === "rejected"
        ? eq(contentItems.status, status)
        : eq(contentItems.status, "draft"))
    .orderBy(desc(contentItems.updatedAt))
    .limit(50);

  // Ham/kuyruktaki içerikler panelde gösterilmez. Yalnızca Mira'nın KEEP seçtiği ve
  // sonradan silinmemiş içerikler kullanıcı onay listesine çıkar.
  if (isDefaultView && rows.length) {
    const analysisOps = await db.select().from(operations)
      .where(eq(operations.action, "content_draft_analysis"))
      .orderBy(desc(operations.id))
      .limit(200);
    // Manuel konu kuyruğundan oluşturulan senaryolar analiz raporuna bağlı değildir;
    // başarılı manuel taslakları da onay listesinde göster.
    const manualDraftOps = await db.select().from(operations)
      .where(eq(operations.action, "autonomous_content_draft"))
      .orderBy(desc(operations.id))
      .limit(200);
    const keptIds = new Set<number>();
    const deletedIds = new Set<number>();
    for (const operation of manualDraftOps) {
      if (operation.status !== "success") continue;
      const metadata = operation.metadata && typeof operation.metadata === "object"
        ? operation.metadata as Record<string, unknown> : {};
      const id = Number(metadata.contentId);
      if (Number.isInteger(id) && id > 0) keptIds.add(id);
    }
    for (const operation of analysisOps) {
      const metadata = operation.metadata && typeof operation.metadata === "object"
        ? operation.metadata as Record<string, unknown> : {};
      if (Array.isArray(metadata.keptContentIds)) {
        for (const value of metadata.keptContentIds) {
          const id = Number(value);
          if (Number.isInteger(id) && id > 0) keptIds.add(id);
        }
      }
      if (Array.isArray(metadata.deletedContentIds)) {
        for (const value of metadata.deletedContentIds) {
          const id = Number(value);
          if (Number.isInteger(id) && id > 0) deletedIds.add(id);
        }
      }
    }
    rows = rows.filter((row) => keptIds.has(row.id) && !deletedIds.has(row.id));
  }

  // Varsayılan listede aynı başlığın kopyaları birikebiliyor (research günlük penceresi
  // yüzünden tarih farklı türlerinin tekrarı). En yenisini tut, eskileri reddet; liste kendini iyileştirir.
  if (isDefaultView && rows.length > 1) {
    const { keep, duplicates } = splitDuplicateRows(rows);
    if (duplicates.length) {
      rows = keep;
      for (const dup of duplicates) {
        try {
          await db.update(contentItems)
            .set({ status: "rejected", updatedAt: new Date() })
            .where(eq(contentItems.id, dup.id));
          await db.insert(operations).values({
            action: "duplicate_cleanup",
            summary: `Kopya taslak otomatik reddedildi: ${dup.title}`,
            status: "success",
            platform: dup.platform,
            metadata: { contentId: dup.id, reason: "same_title_duplicate" },
          });
        } catch (error) {
          console.error("[Review] kopya temizliği yazılamadı:", error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  if (!rows.length) return NextResponse.json([]);
  const ids = rows.map((row) => row.id);

  // ready içerikler için en yeni video varlığını bul (onay ekranındaki oynatıcı buna bağlanır)
  const previewByContentId = new Map<number, number>();
  if (isReady) {
    const assets = await db.select().from(contentAssets)
      .where(inArray(contentAssets.contentId, ids))
      .orderBy(desc(contentAssets.id)).limit(500);
    for (const asset of assets) {
      if (asset.kind === "video" && !previewByContentId.has(asset.contentId)) {
        previewByContentId.set(asset.contentId, asset.id);
      }
    }
  }
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
    const assetId = previewByContentId.get(row.id);
    return {
      ...row,
      generatedScript: typeof metadata.script === "string" ? metadata.script : null,
      generation: op ? { provider: metadata.provider ?? null, model: metadata.model ?? null } : null,
      ...(isReady ? (assetId ? { previewPath: `/api/video/asset/${assetId}`, hasVideo: true } : { hasVideo: false }) : {}),
    };
  }));
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const action = body.action;
  if (!Number.isInteger(id) || id <= 0 || !["approve_video", "approve_text", "reject", "generate_script"].includes(action)) {
    return NextResponse.json({ error: "Geçersiz istek." }, { status: 400 });
  }

  // Kuyruktaki kayıt için senaryoyu yerinde üret: sunucu tarafında worker'ı çağır.
  if (action === "generate_script") {
    const [queued] = await db.select().from(contentItems)
      .where(and(eq(contentItems.id, id), inArray(contentItems.status, ["queued", "processing"])))
      .limit(1);
    if (!queued) {
      return NextResponse.json({ error: "Kayıt kuyrukta değil; senaryoyu zaten üretilmiş olabilir. Listeyi yenile." }, { status: 409 });
    }
    const origin = selfOrigin();
    const secret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "";
    let workerData: { error?: string; message?: string; processed?: boolean } | null = null;
    try {
      const res = await fetch(`${origin}/api/automation/worker?contentId=${id}`, {
        method: "POST",
        headers: { "x-mira-key": secret },
        cache: "no-store",
        signal: AbortSignal.timeout(95_000),
      });
      workerData = await res.json().catch(() => null);
      if (!res.ok) {
        return NextResponse.json({ error: workerData?.error || `Senaryo üretilemedi (worker HTTP ${res.status})` }, { status: 502 });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: `Senaryo üretilemedi: ${detail.slice(0, 200)}` }, { status: 502 });
    }
    await db.insert(operations).values({
      action: "script_generated_on_demand",
      summary: `Senaryo kullanıcı isteğiyle üretildi: ${queued.title}`,
      status: workerData?.processed === false ? "failed" : "success",
      platform: queued.platform,
      metadata: { contentId: id, worker: workerData },
    });
    return NextResponse.json({
      ok: true,
      worker: workerData,
      message: "Senaryo oluşturuldu. Listeyi yenilediğinde onay butonları aktif olacak.",
    });
  }

  // Reddetme taslak/kuyruk/üretilmiş videoları kapsar; onaylama yalnızca senaryosu hazır taslak içindir.
  const allowedStatus = action === "reject" ? ["draft", "queued", "ready"] as const : ["draft"] as const;
  const [draft] = await db.select().from(contentItems)
    .where(and(eq(contentItems.id, id), inArray(contentItems.status, [...allowedStatus])))
    .limit(1);

  if (!draft) return NextResponse.json({ error: "Kayıt bulunamadı veya daha önce değerlendirilmiş." }, { status: 409 });

  const nextStatus = action === "reject" ? "rejected" : "approved";
  const videoRequested = action === "approve_video";
  const [row] = await db.update(contentItems)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(and(eq(contentItems.id, id), eq(contentItems.status, draft.status)))
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
