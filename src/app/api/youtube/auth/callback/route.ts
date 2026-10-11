import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens, getMyChannel, saveYoutubeTokens } from "@/lib/youtube";

export const dynamic = "force-dynamic";

function page(title: string, body: string, ok: boolean) {
  return new NextResponse(
    `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title>
    <style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8e8e8;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
    .card{max-width:520px;padding:32px;background:#151823;border-radius:16px;border:1px solid ${ok ? "#3f5f2f" : "#5f2f2f"}}
    h1{color:${ok ? "#D4FF3F" : "#ff7d7d"};font-size:20px;margin:0 0 12px}p{line-height:1.6;color:#b9b9c4}a{color:#D4FF3F}</style></head>
    <body><div class="card"><h1>${title}</h1><p>${body}</p><p><a href="/">← Mira'ya dön</a></p></div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return page("Bağlantı reddedildi", `Google hata döndürdü: <b>${errorParam}</b>. İzin ekranında devam etmeniz gerekiyor.`, false);
  }

  // Use Next.js cookie parsing instead of manually parsing the Cookie header.
  const cookieState = req.cookies.get("mira_yt_state")?.value;
  if (!code || !state || !cookieState || state !== cookieState) {
    return page("Geçersiz oturum", "Doğrulama durumu (state) uyuşmadı. <a href=\"/api/youtube/auth\">Baştan başla</a>.", false);
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    // Kanal bilgisini de alıp kaydetmeyi dene (1 kota birimi)
    try {
      const channel = await getMyChannel(tokens.accessToken);
      tokens.channelId = channel.channelId;
      tokens.channelTitle = channel.channelTitle;
    } catch {}
    await saveYoutubeTokens(tokens);
    return page(
      "YouTube bağlı! 🎉",
      `<b>${tokens.channelTitle || "Kanal"}</b> hesabı Mira'ya bağlandı. Artık onayladığın videolar otomatik yüklenebilir.<br><br>Varsayılan gizlilik: <b>${process.env.YOUTUBE_DEFAULT_PRIVACY || "private"}</b> — videoyu önce sen kanalında gör, istersen public'e çek.`,
      true,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return page("Bağlantı hatası", message.slice(0, 400), false);
  }
}
