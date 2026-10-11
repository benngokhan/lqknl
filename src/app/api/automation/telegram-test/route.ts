import { NextResponse } from "next/server";
import { sendTelegramMessage } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

function authorized(req: Request) {
  const expected = process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET;
  if (!expected) return false;
  return req.headers.get("x-mira-key") === expected;
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Yetkisiz istek." }, { status: 401 });
  }

  const result = await sendTelegramMessage(
    "✅ Mira Telegram test bildirimi\n\nBu mesaj, manuel test tetikleyicisinden gönderildi. Telegram bağlantısı çalışıyor."
  );

  if (!result.sent) {
    return NextResponse.json({
      ok: false,
      error: result.reason === "not_configured"
        ? "Railway üzerinde TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik."
        : "Telegram mesajı gönderilemedi.",
      detail: result.reason === "send_failed" ? result.error : undefined,
    }, { status: result.reason === "not_configured" ? 503 : 502 });
  }

  return NextResponse.json({ ok: true, sent: true, message: "Telegram test bildirimi gönderildi." });
}
