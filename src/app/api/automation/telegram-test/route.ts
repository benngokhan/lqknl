import { NextResponse } from "next/server";
import { isMiraSessionCookie } from "@/lib/mira-auth";
import { sendTelegramMessage } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

function authorized(req: Request) {
  const expected = (process.env.MIRA_AUTOMATION_SECRET || process.env.MIRA_N8N_SECRET || "").trim();

  if (expected) {
    const headerKey = (req.headers.get("x-mira-key") || "").trim();
    if (headerKey && headerKey === expected) return true;

    const authHeader = (req.headers.get("authorization") || "").trim();
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      const bearerToken = authHeader.slice(7).trim();
      if (bearerToken && bearerToken === expected) return true;
    }
  }

  // Panel tarayıcısı (Mira oturum çerezi) da test tetikleyebilsin
  if (isMiraSessionCookie(req.headers.get("cookie"))) return true;

  // Geliştirme ortamında şifre/secret tanımlı değilse geçişe izin ver
  const entryPassword = (process.env.MIRA_ENTRY_PASSWORD || "").trim();
  if (!expected && !entryPassword && process.env.NODE_ENV !== "production") return true;

  return false;
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Yetkisiz istek." }, { status: 401 });
  }

  const result = await sendTelegramMessage(
    "✅ Mira Telegram test bildirimi\n\nBu mesaj, panelden manuel test butonuyla gönderildi. Telegram bağlantısı çalışıyor."
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
