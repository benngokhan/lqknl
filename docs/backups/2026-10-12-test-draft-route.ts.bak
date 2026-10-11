import { NextResponse } from "next/server";
import { db } from "@/db";
import { contentItems } from "@/db/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request) {
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Giriş gerekli." }, { status: 401 });

  const workerSecret = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (!workerSecret) {
    return NextResponse.json({ error: "İşçi anahtarı sunucuda tanımlı değil; test taslağı başlatılmadı." }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const topic = typeof body.topic === "string" && body.topic.trim()
    ? body.topic.trim().slice(0, 500)
    : "Ahtapotlar çevrelerini nasıl algılar?";
  const title = topic.slice(0, 300);

  const [item] = await db.insert(contentItems).values({
    title,
    platform: "youtube",
    status: "queued",
    topic,
  }).returning();

  try {
    const workerUrl = new URL(`/api/automation/worker?contentId=${item.id}`, req.url);
    const response = await fetch(workerUrl, {
      method: "POST",
      headers: { "x-mira-key": workerSecret, "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(55000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true || result?.processed !== true || result?.status === "failed") {
      return NextResponse.json({
        ok: false,
        contentId: item.id,
        status: result?.status ?? "queued",
        error: result?.error || result?.message || `İşçi başarısız yanıt verdi (HTTP ${response.status}).`,
        notification: result?.notification ?? null,
      }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      contentId: item.id,
      status: result.status ?? "draft",
      title: result.title ?? title,
      provider: result.provider ?? null,
      model: result.model ?? null,
      notification: result.notification ?? null,
      message: "Gerçek içerik işçisi çalıştırıldı. Video üretilmedi ve yayın yapılmadı; içerik Taslaklar deposuna kaydedildi.",
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      contentId: item.id,
      error: error instanceof Error ? error.message : "İçerik işçisine ulaşılamadı.",
      message: "İçerik kuyruğa kaydedildi ancak işçi sonucu doğrulanamadı.",
    }, { status: 502 });
  }
}
