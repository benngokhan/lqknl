export type TelegramSendResult =
  | { sent: true }
  | { sent: false; reason: "not_configured" | "send_failed"; error?: string };

type TelegramButton = { text: string; callback_data: string };

/** Telegram notifications are optional; their failure must not break content production. */
export async function sendTelegramMessage(
  text: string,
  opts?: { parseMode?: "HTML"; inlineKeyboard?: TelegramButton[][] },
): Promise<TelegramSendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return { sent: false, reason: "not_configured" };

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 3900),
        disable_web_page_preview: false,
        ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
        ...(opts?.inlineKeyboard ? { reply_markup: { inline_keyboard: opts.inlineKeyboard } } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    const data = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (!response.ok || data?.ok !== true) {
      return { sent: false, reason: "send_failed", error: data?.description || `Telegram HTTP ${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: "send_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendPublishButton(contentId: number, title: string, videoUrl: string) {
  return sendTelegramMessage(
    `🎬 Video YouTube'a gizli yüklendi.\n\nBaşlık: ${title}\nİçerik: #${contentId}\n\nHerkese açık yapmak istiyorsan aşağıdaki butona bas. Sen basmadan yayınlanmaz.\n${videoUrl}`,
    { inlineKeyboard: [[{ text: "▶️ Yayınla", callback_data: `publish:${contentId}` }]] },
  );
}
