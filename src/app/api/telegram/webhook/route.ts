import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contentItems, operations } from "@/db/schema";
import { makeYoutubeVideoPublic } from "@/lib/youtube";
import { sendTelegramMessage } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function telegramCall(method: string, body: Record<string, unknown>) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN tanımlı değil");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok !== true) throw new Error(data?.description || `Telegram ${method} başarısız`);
  return data.result;
}

export async function POST(req: Request) {
  const secret = (process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "").trim();
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const update = await req.json().catch(() => ({}));
  const callback = update?.callback_query;
  if (!callback?.id) return NextResponse.json({ ok: true });

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  const senderChatId = String(callback.message?.chat?.id ?? "");
  const senderUserId = String(callback.from?.id ?? "");
  const configuredChatId = chatId || "";
  if (!token || !configuredChatId || senderChatId !== configuredChatId || senderUserId !== configuredChatId) {
    await telegramCall("answerCallbackQuery", { callback_query_id: callback.id, text: "Bu işlem için yetki yok.", show_alert: true }).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  const match = /^publish:(\d+)$/.exec(String(callback.data || ""));
  if (!match) {
    await telegramCall("answerCallbackQuery", { callback_query_id: callback.id, text: "Bilinmeyen işlem.", show_alert: true }).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  const contentId = Number(match[1]);
  try {
    const [content] = await db.select().from(contentItems)
      .where(and(eq(contentItems.id, contentId), eq(contentItems.status, "published"), eq(contentItems.platform, "youtube")))
      .limit(1);
    if (!content?.externalId) throw new Error("Bu içerik için yüklenmiş YouTube videosu bulunamadı.");

    const records = await db.select().from(operations)
      .where(and(eq(operations.action, "content_publish"), eq(operations.status, "success")))
      .orderBy(desc(operations.id)).limit(300);
    const uploadRecord = records.find((op) => {
      const meta = op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {};
      return Number(meta.contentId) === contentId && String(meta.videoId || op.externalId || "") === content.externalId;
    });
    if (!uploadRecord) throw new Error("Yükleme kaydı doğrulanamadı; güvenlik için yayın durduruldu.");

    const publicRecords = await db.select().from(operations)
      .where(and(eq(operations.action, "youtube_make_public"), eq(operations.status, "success")))
      .orderBy(desc(operations.id)).limit(300);
    const alreadyPublic = publicRecords.find((op) => {
      const meta = op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {};
      return Number(meta.contentId) === contentId && String(meta.videoId || op.externalId || "") === content.externalId;
    });
    if (alreadyPublic) {
      await telegramCall("answerCallbackQuery", { callback_query_id: callback.id, text: "Bu video zaten yayınlandı." }).catch(() => {});
      return NextResponse.json({ ok: true });
    }

    await telegramCall("answerCallbackQuery", { callback_query_id: callback.id, text: "Yayın isteğin işleniyor…" });
    const result = await makeYoutubeVideoPublic(content.externalId);
    await db.insert(operations).values({
      action: "youtube_make_public",
      summary: `Telegram kullanıcı onayıyla YouTube videosu herkese açık yapıldı: #${contentId}`,
      status: "success",
      platform: "youtube",
      externalId: result.videoId,
      metadata: { contentId, videoId: result.videoId, url: result.url, privacyStatus: result.privacyStatus, approvedByTelegramUserId: senderUserId },
    });
    await sendTelegramMessage(`✅ Yayınlandı!\n\n${content.title}\n${result.url}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await telegramCall("answerCallbackQuery", { callback_query_id: callback.id, text: message.slice(0, 180), show_alert: true }).catch(() => {});
    await sendTelegramMessage(`❌ Yayınlama tamamlanamadı. Video gizli kalmış olabilir.\nİçerik #${contentId}\nHata: ${message.slice(0, 500)}`);
  }
  return NextResponse.json({ ok: true });
}
