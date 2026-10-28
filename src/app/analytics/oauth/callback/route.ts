import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /analytics/oauth/callback?code=...
 * YouTube Analytics OAuth: Google'ın yönlendirdiği kodu kullanıcıya gösterir.
 * Kod Arena sohbetine yapıştırılır; token takası GitHub Actions tarafında yapılır.
 * Burada HİÇBİR sır tutulmaz.
 */
export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get("code") || "";
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KartaL Analitik — Kod</title>
<style>
body{font-family:system-ui,sans-serif;background:#0d0f12;color:#e8e8e8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
.kutu{max-width:520px;width:100%;background:#15181d;border:1px solid #2a2f37;border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 8px}
p{font-size:14px;color:#9aa4b2;line-height:1.5}
textarea{width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;background:#0d0f12;color:#D4FF3F;border:1px solid #2a2f37;border-radius:8px;padding:12px;height:120px;margin:12px 0}
.btn{display:block;width:100%;text-align:center;background:#D4FF3F;color:#0d0f12;font-weight:700;border:none;border-radius:8px;padding:12px;font-size:15px;cursor:pointer}
.err{color:#ff6b6b}
</style></head><body><div class="kutu">
<h1>📊 YouTube Analytics kurulumu</h1>
${
    code
      ? `<p>Bu kodu <b>Arena</b>'daki sohbete yapıştır (10 dk içinde geçerlidir):</p>
         <textarea id="kod" readonly onclick="this.select()">${code.replace(/</g, "&lt;")}</textarea>
         <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('kod').value).then(()=>alert('Kopyalandı — Arena\\'ya yapıştır'))">Kodu Kopyala</button>`
      : `<p class="err">Kod alınamadı — kurulumu Arena'daki sohbetten yeniden başlat.</p>`
  }
</div></body></html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
