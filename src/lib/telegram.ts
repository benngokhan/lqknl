export type TelegramSendResult =
  | { sent: true }
  | { sent: false; reason: "not_configured" | "send_failed"; error?: string };

/**
 * Optional Telegram notification. Missing credentials never break content production.
 * Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Railway.
 */
export async function sendTelegramMessage(text: string, opts?: { parseMode?: "HTML" }): Promise<TelegramSendResult> {
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
    return {
      sent: false,
      reason: "send_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
