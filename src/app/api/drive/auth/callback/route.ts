import { NextRequest, NextResponse } from "next/server";
import { exchangeDriveCode, saveDriveTokens } from "@/lib/google-drive";

export const dynamic = "force-dynamic";

function page(title: string, message: string, ok: boolean) {
  const safeTitle = title.replace(/[&<>"]/g, "");
  const safeMessage = message.replace(/[&<>"]/g, "");
  return new NextResponse(
    `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title>
    <style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8e8e8;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.card{max-width:520px;padding:28px;background:#151823;border-radius:16px;border:1px solid ${ok ? "#3f5f2f" : "#5f2f2f"}}h1{color:${ok ? "#D4FF3F" : "#ff7d7d"};font-size:20px}p{line-height:1.6;color:#b9b9c4}</style></head>
    <body><div class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p><p><a style="color:#D4FF3F" href="/">Mira'ya dön</a></p></div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  if (errorParam) return page("Drive bağlantısı reddedildi", "Google izin ekranında erişim onaylanmadı.", false);

  const cookieState = req.cookies.get("mira_drive_state")?.value;
  if (!code || !state || !cookieState || state !== cookieState) {
    return page("Geçersiz oturum", "Güvenlik doğrulaması uyuşmadı. Mira içinden Drive bağlantısını yeniden başlat.", false);
  }

  try {
    const tokens = await exchangeDriveCode(code);
    await saveDriveTokens(tokens);
    const response = page("Google Drive Mira'ya bağlandı", "Salt okunur Drive izni kaydedildi. YouTube bağlantısı ayrı tutuluyor. Dosya listesini test etmek için /api/drive/files adresini açabilirsin.", true);
    response.cookies.set("mira_drive_state", "", { httpOnly: true, secure: true, sameSite: "none", path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen bağlantı hatası";
    return page("Drive bağlantı hatası", message.slice(0, 350), false);
  }
}
