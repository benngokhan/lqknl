import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contentItems, operations } from "@/db/schema";
import { sendPublishButton } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function loggedIn(req: Request) {
  return req.headers.get("cookie")?.split(";").some((part) => part.trim() === "mira_entry=1") ?? false;
}

export async function GET(req: Request) {
  if (!loggedIn(req)) return NextResponse.json({ ok: false, error: "Önce Mira paneline giriş yap." }, { status: 401 });

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const webhookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "").trim();
  if (!botToken || !process.env.TELEGRAM_CHAT_ID?.trim()) {
    return NextResponse.json({ ok: false, error: "Railway'de TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID eksik." }, { status: 503 });
  }
  if (!webhookSecret || !/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    return NextResponse.json({ ok: false, error: "Railway'de TELEGRAM_WEBHOOK_SECRET ekle (yalnızca İngilizce harf, sayı, _ ve -)." }, { status: 503 });
  }

  const base = new URL(req.url).origin;
  const webhookUrl = `${base}/api/telegram/webhook`;
  const setup = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret, allowed_updates: ["callback_query"] }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const setupData = await setup.json().catch(() => ({}));
  if (!setup.ok || setupData?.ok !== true) {
    return NextResponse.json({ ok: false, error: setupData?.description || "Telegram webhook kurulamadı." }, { status: 502 });
  }

  const contentId = Number(new URL(req.url).searchParams.get("contentId"));
  if (Number.isInteger(contentId) && contentId > 0) {
    const [content] = await db.select().from(contentItems)
      .where(and(eq(contentItems.id, contentId), eq(contentItems.status, "published"), eq(contentItems.platform, "youtube")))
      .limit(1);
    if (!content?.externalId || !content.url) {
      return NextResponse.json({ ok: false, webhookReady: true, error: `#${contentId} için YouTube video kaydı bulunamadı.` }, { status: 404 });
    }
    const records = await db.select().from(operations)
      .where(and(eq(operations.action, "content_publish"), eq(operations.status, "success")))
      .orderBy(desc(operations.id)).limit(300);
    const uploadRecord = records.find((op) => {
      const meta = op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {};
      return Number(meta.contentId) === contentId && String(meta.videoId || op.externalId || "") === content.externalId;
    });
    const meta = uploadRecord?.metadata && typeof uploadRecord.metadata === "object"
      ? uploadRecord.metadata as Record<string, unknown> : {};
    if (!uploadRecord || meta.privacyStatus !== "private") {
      return NextResponse.json({ ok: false, webhookReady: true, error: "Bu video gizli yükleme kaydı olarak doğrulanamadı; buton gönderilmedi." }, { status: 409 });
    }
    const sent = await sendPublishButton(content.id, content.title, content.url);
    return NextResponse.json({ ok: sent.sent, webhookReady: true, button: sent, contentId, message: sent.sent ? "Telegram Yayınla butonu gönderildi." : "Webhook kuruldu fakat buton gönderilemedi." }, { status: sent.sent ? 200 : 502 });
  }

  return NextResponse.json({ ok: true, webhookReady: true, message: "Telegram yayın onayı webhook'u kuruldu. Mevcut video için ?contentId=106 ekleyebilirsin." });
}
