export type TelegramSendResult =
  | { sent: true; targetChatIdMasked: string; messageId: number | null; chatType: string | null }
  | { sent: false; reason: "not_configured" | "send_failed"; error?: string; targetChatIdMasked?: string };

type TelegramButton = { text: string; callback_data: string };

function maskChatId(chatId: string) {
  if (chatId.length <= 4) return "****";
  return `${chatId.slice(0, 2)}•••${chatId.slice(-2)}`;
}

/** Telegram notifications are optional; report Telegram's actual API result without exposing secrets. */
export async function sendTelegramMessage(
  text: string,
  opts?: { parseMode?: "HTML"; inlineKeyboard?: TelegramButton[][] },
): Promise<TelegramSendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  const targetChatIdMasked = chatId ? maskChatId(chatId) : undefined;
  if (!token || !chatId) {
    console.error("[telegram] not_configured", JSON.stringify({
      tokenConfigured: Boolean(token),
      chatIdConfigured: Boolean(chatId),
    }));
    return { sent: false, reason: "not_configured" };
  }

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
    const data = await response.json().catch(() => null) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number; chat?: { id?: number | string; type?: string } };
    } | null;
    if (!response.ok || data?.ok !== true) {
      const error = data?.description || `Telegram HTTP ${response.status}`;
      console.error("[telegram] send_failed", JSON.stringify({
        httpStatus: response.status,
        targetChatIdMasked,
        error,
      }));
      return { sent: false, reason: "send_failed", error, targetChatIdMasked };
    }

    const messageId = typeof data.result?.message_id === "number" ? data.result.message_id : null;
    const chatType = typeof data.result?.chat?.type === "string" ? data.result.chat.type : null;
    const apiChatId = data.result?.chat?.id != null ? String(data.result.chat.id) : "";
    console.info("[telegram] send_succeeded", JSON.stringify({
      httpStatus: response.status,
      configuredTargetChatIdMasked: targetChatIdMasked,
      apiReturnedChatIdMasked: apiChatId ? maskChatId(apiChatId) : null,
      messageId,
      chatType,
    }));
    return { sent: true, targetChatIdMasked: targetChatIdMasked!, messageId, chatType };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[telegram] send_failed", JSON.stringify({ targetChatIdMasked, error: detail }));
    return { sent: false, reason: "send_failed", error: detail, targetChatIdMasked };
  }
}

export async function sendPublishButton(contentId: number, title: string, videoUrl: string) {
  return sendTelegramMessage(
    `🎬 Video YouTube'a gizli yüklendi.\n\nBaşlık: ${title}\nİçerik: #${contentId}\n\nHerkese açık yapmak istiyorsan aşağıdaki butona bas. Sen basmadan yayınlanmaz.\n${videoUrl}`,
    { inlineKeyboard: [[{ text: "▶️ Yayınla", callback_data: `publish:${contentId}` }]] },
  );
}
